import { Cron } from 'croner'
import { and, eq, isNull } from 'drizzle-orm'
import type { Db, Schema } from './db'
import { isDryRun } from './history'
import type { Notifier } from './notify'
import type { SaltService } from './salt'
import { complianceCounts, complianceMessage, failureSummary, functionMessage, patchMessage, patchSummary } from './summaries'

export const SCHEDULE_KINDS = {
  compliance: 'Compliance check (state.apply test=True)',
  patches: 'Patch scan (pkg.list_upgrades)',
  function: 'Any function',
} as const
export type ScheduleKind = keyof typeof SCHEDULE_KINDS

type ScheduleRow = Schema['schedule']['$inferSelect']

/** Throws a readable error for an invalid cron expression; returns the next run otherwise. */
export function nextRun(cron: string, from = new Date()) {
  return new Cron(cron, { paused: true }).nextRun(from)
}

/** When a schedule is next due: the first cron slot after its last run (or its creation). */
export function dueAt(s: Pick<ScheduleRow, 'cron' | 'lastRunAt' | 'createdAt'>) {
  return nextRun(s.cron, s.lastRunAt ?? s.createdAt)
}

/** The salt-api lowstate a schedule runs. */
export function lowstateFor(s: Pick<ScheduleRow, 'id' | 'name' | 'kind' | 'fun' | 'args' | 'target' | 'targetType'>) {
  const base = {
    client: 'local_async',
    tgt: s.target,
    tgt_type: s.targetType,
    metadata: { salt_shaker_user: `schedule:${s.name}`, salt_shaker_schedule: s.id },
  }
  if (s.kind === 'compliance') return { ...base, fun: 'state.apply', arg: [], kwarg: { test: true } }
  if (s.kind === 'patches') return { ...base, fun: 'pkg.list_upgrades', arg: [], kwarg: { refresh: true } }
  const args = s.args ? (JSON.parse(s.args) as { arg?: unknown[]; kwarg?: Record<string, unknown> }) : {}
  return { ...base, fun: s.fun ?? 'test.ping', arg: args.arg ?? [], kwarg: args.kwarg ?? {} }
}

const TICK_MS = 20_000
// give slow highstates time to finish before summarizing what came back
const RESULT_DEADLINE_MS = 15 * 60_000

interface Pending {
  schedule: ScheduleRow
  minions: string[]
  deadline: number
}

export class Scheduler {
  private db: Db
  private schema: Schema
  private salt: SaltService
  private notifier: Notifier
  private audit: (row: { username: string; client: string; fun: string; target: string; targetType: string; jid: string | null; outcome: string; error?: string }) => Promise<unknown>
  private pending = new Map<string, Pending>()
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false

  constructor(db: Db, schema: Schema, salt: SaltService, notifier: Notifier, audit: Scheduler['audit']) {
    this.db = db
    this.schema = schema
    this.salt = salt
    this.notifier = notifier
    this.audit = audit
  }

  start() {
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    void this.tick()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
  }

  async tick() {
    if (this.ticking) return
    this.ticking = true
    try {
      const t = this.schema.schedule
      const now = new Date()
      for (const s of await this.db.select().from(t).where(eq(t.enabled, true))) {
        let due: Date | null
        try {
          due = dueAt(s)
        } catch {
          continue // invalid cron saved before validation existed; the UI shows it
        }
        if (!due || due > now) continue
        // claim this run: only the instance whose update matches the old lastRunAt gets to start it
        const claimed = await this.db
          .update(t)
          .set({ lastRunAt: now })
          .where(and(eq(t.id, s.id), s.lastRunAt ? eq(t.lastRunAt, s.lastRunAt) : isNull(t.lastRunAt)))
          .returning({ id: t.id })
        if (claimed.length) await this.run({ ...s, lastRunAt: now })
      }
      await this.collect()
    } catch (e) {
      console.warn('scheduler: tick failed', e)
    } finally {
      this.ticking = false
    }
  }

  /** Starts a schedule's job now (from the tick, or "Run now" in the UI). */
  async run(s: ScheduleRow) {
    const low = lowstateFor(s)
    const who = `schedule:${s.name}`
    try {
      const ret = (await this.salt.call(low)) as { jid?: string; minions?: string[] } | ''
      if (!ret || !ret.jid) {
        await this.audit({ username: who, client: 'local_async', fun: low.fun, target: s.target, targetType: s.targetType, jid: null, outcome: 'error', error: 'No minions matched the target' })
        await this.db.update(this.schema.schedule).set({ lastSummary: JSON.stringify({ error: 'No minions matched the target' }) }).where(eq(this.schema.schedule.id, s.id))
        return null
      }
      await this.db.update(this.schema.schedule).set({ lastJid: ret.jid }).where(eq(this.schema.schedule.id, s.id))
      await this.record(ret.jid, low, ret.minions ?? [], who)
      await this.audit({ username: who, client: 'local_async', fun: low.fun, target: s.target, targetType: s.targetType, jid: ret.jid, outcome: 'ok' })
      this.pending.set(ret.jid, { schedule: s, minions: ret.minions ?? [], deadline: Date.now() + RESULT_DEADLINE_MS })
      return ret.jid
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      await this.audit({ username: who, client: 'local_async', fun: low.fun, target: s.target, targetType: s.targetType, jid: null, outcome: 'error', error })
      await this.db.update(this.schema.schedule).set({ lastSummary: JSON.stringify({ error }) }).where(eq(this.schema.schedule.id, s.id))
      return null
    }
  }

  /**
   * Stores the job right away, so the history has it even for functions it otherwise skips
   * (e.g. test.ping) and before the master's "new" event arrives.
   */
  private async record(jid: string, low: ReturnType<typeof lowstateFor>, minions: string[], who: string) {
    const job = this.schema.job
    // same shape as the master's events: keyword arguments last, marked with __kwarg__
    const args: unknown[] = [...low.arg, ...(Object.keys(low.kwarg).length ? [{ __kwarg__: true, ...low.kwarg }] : [])]
    await this.db
      .insert(job)
      .values({ jid, fun: low.fun, args: JSON.stringify(args), target: low.tgt, targetType: low.tgt_type, shakerUser: who, minions: JSON.stringify(minions), dryRun: isDryRun(args), startedAt: new Date() })
      .onConflictDoNothing()
    await this.db.update(job).set({ shakerUser: who }).where(and(eq(job.jid, jid), isNull(job.shakerUser)))
  }

  /** Summarizes runs whose minions have all returned (or that hit the deadline) and notifies. */
  private async collect() {
    for (const [jid, p] of this.pending) {
      const rows = await this.db.select().from(this.schema.jobReturn).where(eq(this.schema.jobReturn.jid, jid))
      if (rows.length < p.minions.length && Date.now() < p.deadline) continue
      this.pending.delete(jid)
      const s = p.schedule
      const target = `${s.targetType !== 'glob' ? `${s.targetType}:` : ''}${s.target}`
      let summary: unknown
      if (s.kind === 'compliance') {
        const c = complianceCounts(rows, p.minions.length)
        summary = c
        const msg = complianceMessage(s.name, target, c, jid)
        if (c.drift + c.error > 0) await this.notifier.emit('drift', msg)
        await this.notifier.emit('schedule', msg)
      } else if (s.kind === 'patches') {
        const ps = patchSummary(rows, p.minions.length)
        summary = ps
        const msg = patchMessage(s.name, target, ps, jid)
        if (ps.needUpdates > 0) await this.notifier.emit('patches', msg)
        await this.notifier.emit('schedule', msg)
      } else {
        const f = failureSummary(rows, p.minions.length)
        summary = { returned: f.returned, failed: f.failed.length, noreturn: f.noreturn }
        await this.notifier.emit('schedule', functionMessage(s.name, s.fun ?? '?', target, f, jid))
      }
      await this.db.update(this.schema.schedule).set({ lastSummary: JSON.stringify(summary) }).where(eq(this.schema.schedule.id, s.id))
    }
  }
}
