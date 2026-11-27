import { and, eq, inArray, isNull, lte, or, sql, type AnyColumn } from 'drizzle-orm'
import { Hono } from 'hono'
import { trimFleet } from '../src/lib/fleet'
import type { Db, Schema } from './db'
import { isDryRun, type JobRet } from './history'
import { latestCompliance, latestUpdates } from './minion-jobs'
import { canFor } from './roles'
import type { SaltService } from './salt'
import { complianceStatus } from './summaries'
import type { Env, SessionUser } from './types'
import { pick, type Visible } from './visible'

/*
 * The fleet's state in the database. Opening Minions, Map or Overview used to ask the master for
 * everything (grains of every minion, a ping of every minion) for each user, each time. Now the
 * server asks on its own schedule, follows the event bus for what changes in between, and pages
 * read one table.
 */

type Salt = Pick<SaltService, 'call'>

const CHUNK = 200
const chunks = <T>(list: T[]) => Array.from({ length: Math.ceil(list.length / CHUNK) }, (_, i) => list.slice(i * CHUNK, (i + 1) * CHUNK))

/** How many packages a pkg.list_upgrades return lists, or null when the scan failed. */
export function upgradeCount(ret: string | null, retcode: number | null): number | null {
  if (!ret || retcode) return null
  let ups: unknown
  try {
    ups = JSON.parse(ret)
  } catch {
    return null
  }
  // a failed scan returns an error string; a huge one is stored as a marker
  if (!ups || typeof ups !== 'object' || Array.isArray(ups) || '_truncated' in ups) return null
  return Object.keys(ups).length
}

export interface MinionState {
  grains: Record<string, unknown> | null
  /** whether it answered the last status check; null when none ran since its key was accepted */
  up: boolean | null
  compliance: { status: 'ok' | 'drift' | 'error'; jid: string; checkedAt: Date } | null
  updates: { packages: number; jid: string; checkedAt: Date } | null
}

/** Every accepted minion as the fleet pages show it, and when who answers was last checked. */
export async function minionState(db: Db, schema: Schema) {
  const rows = await db.select().from(schema.minion)
  const minions: Record<string, MinionState> = {}
  let statusAt: Date | null = null
  for (const r of rows) {
    if (r.statusAt && (!statusAt || r.statusAt > statusAt)) statusAt = r.statusAt
    minions[r.id] = {
      grains: r.grains ? (JSON.parse(r.grains) as Record<string, unknown>) : null,
      up: r.up,
      compliance: r.complianceStatus && r.complianceJid && r.complianceAt ? { status: r.complianceStatus as 'ok' | 'drift' | 'error', jid: r.complianceJid, checkedAt: r.complianceAt } : null,
      updates: r.updatesPackages !== null && r.updatesJid && r.updatesAt ? { packages: r.updatesPackages, jid: r.updatesJid, checkedAt: r.updatesAt } : null,
    }
  }
  return { minions, statusAt }
}

export interface CollectorDeps {
  db: Db
  schema: Schema
  /** for the collector's own rounds; a user's Refresh passes theirs */
  salt: Salt
  /** between rounds that read keys and grains (and ask who answers, with `checksStatus`) */
  intervalMs?: number
  /** ask who answers in every round; off when the presence check does and passes it on */
  checksStatus?: boolean
  /** how long minions seen on the event bus wait before they're written as up */
  flushMs?: number
  now?: () => Date
}

export class MinionCollector {
  private d: CollectorDeps
  private timers: Array<ReturnType<typeof setInterval>> = []
  private soon: ReturnType<typeof setTimeout> | null = null
  private running: { status: boolean; done: Promise<void> } | null = null
  /** minions that showed up on the event bus since the last flush */
  private seen = new Set<string>()
  /** and when, for a couple of minutes: a new minion often starts before its row exists */
  private lately = new Map<string, number>()

  constructor(d: CollectorDeps) {
    this.d = d
  }

  private now() {
    return this.d.now?.() ?? new Date()
  }

  /** On the instance that follows the event bus. Safe to call again after stop(). */
  start() {
    if (this.timers.length) return
    const round = () => void this.collect({ status: this.d.checksStatus }).catch((e) => console.warn('minions: reading the fleet failed', e instanceof Error ? e.message : e))
    round()
    this.timers.push(setInterval(round, this.d.intervalMs ?? 5 * 60_000))
    this.timers.push(setInterval(() => void this.flushSeen().catch((e) => console.warn('minions: recording who answered failed', e)), this.d.flushMs ?? 15_000))
  }

  stop() {
    this.timers.forEach(clearInterval)
    this.timers = []
    if (this.soon) clearTimeout(this.soon)
    this.soon = null
    this.seen.clear()
    this.lately.clear()
  }

  private mark(id: string) {
    this.seen.add(id)
    this.lately.set(id, Date.now())
  }

  /**
   * Reads the accepted keys and their grains from the master into the table, and with `status`
   * also asks who answers. One round runs at a time; a caller that a running round covers waits
   * for that one.
   */
  async collect(opts: { status?: boolean; salt?: Salt } = {}): Promise<void> {
    const status = !!opts.status
    while (this.running) {
      const { status: covers, done } = this.running
      if (covers || !status) return done
      await done.catch(() => undefined)
    }
    const done = this.round(opts.salt ?? this.d.salt, status).finally(() => (this.running = null))
    this.running = { status, done }
    return done
  }

  private async round(salt: Salt, status: boolean) {
    const { db, schema } = this.d
    const t = schema.minion
    const keys = (await salt.call({ client: 'wheel', fun: 'key.list_all' })) as { data?: { return?: { minions?: string[] } } } | null
    const accepted = keys?.data?.return?.minions
    if (!Array.isArray(accepted)) throw new Error('the master did not list its keys')
    // an empty cache (minion_data_cache off) or a failure leaves the grains as they were
    const grains = trimFleet(((await salt.call({ client: 'runner', fun: 'cache.grains', tgt: '*', tgt_type: 'glob' }).catch(() => null)) ?? {}) as Record<string, unknown>)

    const have = new Map((await db.select({ id: t.id, grains: t.grains }).from(t)).map((r) => [r.id, r.grains]))
    const keep = new Set(accepted)
    const gone = [...have.keys()].filter((id) => !keep.has(id))
    for (const c of chunks(gone)) await db.delete(t).where(inArray(t.id, c))

    // only what changed is written: most rounds find the fleet as it was
    const added: string[] = []
    const changed: Array<{ id: string; grains: string | null }> = []
    for (const id of accepted) {
      const json = grains[id] ? JSON.stringify(grains[id]) : null
      if (!have.has(id)) {
        added.push(id)
        changed.push({ id, grains: json })
      } else if (json && json !== have.get(id)) changed.push({ id, grains: json })
    }
    for (const c of chunks(changed)) await db.insert(t).values(c).onConflictDoUpdate({ target: t.id, set: { grains: sql`excluded.grains` } })
    if (added.length) await this.backfill(added)
    // a minion that started just before its key's row was written is up
    for (const id of added) if (this.lately.has(id)) this.seen.add(id)

    if (status) {
      // kwarg, not a top-level timeout: that one is salt-api's own limit (see SaltApi.status)
      const res = (await salt.call({ client: 'runner', fun: 'manage.status', kwarg: { timeout: 3, gather_job_timeout: 3 } })) as { up?: string[]; down?: string[] } | null
      if (res && Array.isArray(res.up) && Array.isArray(res.down)) await this.recordStatus(res.up, res.down)
    }
  }

  /** What history already knows about minions new to the table (all of them after an upgrade). */
  private async backfill(ids: string[]) {
    const { db, schema } = this.d
    const t = schema.minion
    const [compliance, updates] = await Promise.all([latestCompliance(db, schema), latestUpdates(db, schema)])
    for (const id of ids) {
      const c = compliance[id]
      const u = updates[id]
      if (!c && !u) continue
      await db
        .update(t)
        .set({ ...(c ? { complianceStatus: c.status, complianceJid: c.jid, complianceAt: c.checkedAt } : {}), ...(u ? { updatesPackages: u.packages, updatesJid: u.jid, updatesAt: u.checkedAt } : {}) })
        .where(eq(t.id, id))
    }
  }

  /** One answer of manage.status: who is up and who isn't. Minions it doesn't name keep what they had. */
  async recordStatus(up: string[], down: string[], at = this.now()) {
    const { db, schema } = this.d
    const t = schema.minion
    for (const c of chunks(up)) await db.update(t).set({ up: true, statusAt: at }).where(inArray(t.id, c))
    for (const c of chunks(down)) await db.update(t).set({ up: false, statusAt: at }).where(inArray(t.id, c))
    for (const id of up) this.seen.delete(id)
  }

  /** A minion that returns a job or starts is up, without waiting for the next status check. */
  async flushSeen() {
    for (const [id, at] of this.lately) if (Date.now() - at > 120_000) this.lately.delete(id)
    if (!this.seen.size) return
    const ids = [...this.seen]
    this.seen.clear()
    const { db, schema } = this.d
    const t = schema.minion
    const at = this.now()
    // only those marked down or never checked: the time of the last full check stays what it was
    for (const c of chunks(ids)) await db.update(t).set({ up: true, statusAt: at }).where(and(inArray(t.id, c), or(isNull(t.up), eq(t.up, false))))
  }

  /** Master events (on the instance that follows the bus): key changes and minions starting. */
  onEvent(tag: string) {
    if (tag === 'salt/key') {
      // a key was accepted or deleted: read the fleet again, once a burst of them has settled
      this.soon ??= setTimeout(() => {
        this.soon = null
        void this.collect().catch((e) => console.warn('minions: reading the fleet failed', e instanceof Error ? e.message : e))
      }, 3000)
      return
    }
    const started = /^salt\/minion\/(.+)\/start$/.exec(tag)
    if (started) this.mark(started[1])
  }

  /** A recorded job return: the minion answered, and a compliance check or patch scan is its latest. */
  async onReturn(r: JobRet) {
    this.mark(r.minion)
    const { db, schema } = this.d
    const t = schema.minion
    const newer = (col: AnyColumn) => and(eq(t.id, r.minion), or(isNull(col), lte(col, r.returnedAt)))
    if (r.fun === 'state.apply' || r.fun === 'state.highstate') {
      let dry = false
      try {
        dry = isDryRun(JSON.parse(r.args))
      } catch {
        // not a compliance check then
      }
      if (dry) await db.update(t).set({ complianceStatus: complianceStatus(r.summary), complianceJid: r.jid, complianceAt: r.returnedAt }).where(newer(t.complianceAt))
    } else if (r.fun === 'pkg.list_upgrades') {
      // a failed scan doesn't count, so an older good one still shows
      const packages = upgradeCount(r.ret, r.retcode)
      if (packages !== null) await db.update(t).set({ updatesPackages: packages, updatesJid: r.jid, updatesAt: r.returnedAt }).where(newer(t.updatesAt))
    }
  }
}

export function minionRoutes({ db, schema, collector, salt, visibleTo = async () => null }: { db: Db; schema: Schema; collector: MinionCollector; salt: Salt; visibleTo?: (user: SessionUser) => Promise<Visible> }) {
  const r = new Hono<Env>()
  // a scoped user sees their minions only
  const mine = async (user: SessionUser, state: Awaited<ReturnType<typeof minionState>>) => ({ ...state, minions: pick(await visibleTo(user), state.minions) })

  const guard = (user: Env['Variables']['user']) => {
    if (!user) return { error: 'Not signed in', status: 401 as const }
    const can = canFor(user.role)
    if (!can('runner', 'cache.grains') || !can('runner', 'manage.status')) return { error: 'Your role may not read the fleet', status: 403 as const }
    return null
  }

  r.get('/minions', async (c) => {
    const no = guard(c.get('user'))
    if (no) return c.json({ error: no.error }, no.status)
    let state = await minionState(db, schema)
    // nothing was checked yet (first start, or this instance doesn't follow the bus): read it now
    if (!state.statusAt) {
      try {
        await collector.collect({ status: true, salt })
        state = await minionState(db, schema)
      } catch (e) {
        if (!Object.keys(state.minions).length) return c.json({ error: e instanceof Error ? e.message : 'Reading the fleet failed' }, 502)
      }
    }
    return c.json(await mine(c.get('user')!, state))
  })

  /** The Refresh button: ask the master now, then answer like GET. */
  r.post('/minions/refresh', async (c) => {
    const no = guard(c.get('user'))
    if (no) return c.json({ error: no.error }, no.status)
    try {
      await collector.collect({ status: true, salt })
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : 'Reading the fleet failed' }, 502)
    }
    return c.json(await mine(c.get('user')!, await minionState(db, schema)))
  })

  return r
}
