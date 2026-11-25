import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import { stateSummary } from '../src/lib/states'
import { pruneAudit } from './audit'
import type { Db, Schema } from './db'
import { jidOffset, jobEvents, jobsAfter, type JobDetail, type ListedJob } from './catchup'
import type { EventHub } from './events'
import type { SaltService } from './salt'
import { parseSaltStamp } from '../src/lib/stamp'

/**
 * Records jobs from the master's event bus into the database, so history outlives the
 * master's job cache (keep_jobs, 24h by default) and shows who ran what.
 */

// polling and lookups the UI (and manage.status) fire constantly; not worth keeping
const NOISE = new Set(['saltutil.find_job', 'saltutil.running', 'sys.list_functions', 'grains.items', 'grains.item', 'grains.get', 'grains.ls', 'test.ping', 'test.version', 'pkg.version'])

// returns bigger than this are stored as a marker instead (e.g. huge grains or file contents)
const MAX_RETURN_BYTES = 512 * 1024

export interface NewJob {
  jid: string
  fun: string
  args: string
  target: string | null
  targetType: string | null
  saltUser: string | null
  minions: string
  dryRun: boolean
  startedAt: Date
}

export interface JobRet {
  jid: string
  minion: string
  fun: string
  args: string
  saltUser: string | null
  shakerUser: string | null
  ret: string
  retcode: number | null
  success: boolean | null
  summary: string | null
  returnedAt: Date
}

// when the event was made, or now if it carries no stamp Salt Shaker can read
const stamp = (s: unknown) => parseSaltStamp(s) ?? new Date()

/** Whether a return counts as failed in lists of jobs: a non-zero retcode, or success: false. */
export const returnFailed = (r: { retcode: number | null; success: boolean | null }) => (r.retcode !== null && r.retcode !== 0) || r.success === false

/** test=True arrives as a trailing {__kwarg__: true, test: true} argument. */
export const isDryRun = (args: unknown) =>
  Array.isArray(args) && args.some((a) => !!a && typeof a === 'object' && (a as Record<string, unknown>).__kwarg__ === true && (a as Record<string, unknown>).test === true)

function serialize(ret: unknown) {
  const json = JSON.stringify(ret ?? null)
  return json.length > MAX_RETURN_BYTES ? JSON.stringify({ _truncated: true, bytes: json.length }) : json
}

/**
 * Whether a job of this function is kept. A schedule may run a "noisy" function on purpose: its
 * returns carry the schedule in their metadata ("new" events don't, so the scheduler records those
 * jobs itself).
 */
export function worthRecording(fun: string, metadata: Record<string, unknown>) {
  const scheduled = typeof metadata.salt_shaker_user === 'string' && metadata.salt_shaker_user.startsWith('schedule:')
  return (!NOISE.has(fun) || scheduled) && !fun.startsWith('runner.') && !fun.startsWith('wheel.')
}

/** Turns one salt event into a row to store, or null if it isn't a job event worth keeping. */
export function parseJobEvent(tag: string, data: Record<string, unknown>): { kind: 'new'; job: NewJob } | { kind: 'ret'; ret: JobRet } | null {
  const m = tag.match(/^salt\/job\/(\d{20})\/(new|ret\/(.+))$/)
  if (!m) return null
  const fun = typeof data.fun === 'string' ? data.fun : null
  const meta = data.metadata && typeof data.metadata === 'object' ? (data.metadata as Record<string, unknown>) : {}
  if (!fun || !worthRecording(fun, m[2] === 'new' ? {} : meta)) return null
  const jid = m[1]
  if (m[2] === 'new') {
    const tgt = data.tgt
    return {
      kind: 'new',
      job: {
        jid,
        fun,
        args: JSON.stringify(data.arg ?? []),
        target: Array.isArray(tgt) ? tgt.join(',') : typeof tgt === 'string' ? tgt : null,
        targetType: typeof data.tgt_type === 'string' ? data.tgt_type : null,
        saltUser: typeof data.user === 'string' ? data.user : null,
        minions: JSON.stringify(Array.isArray(data.minions) ? data.minions : []),
        dryRun: isDryRun(data.arg),
        startedAt: stamp(data._stamp),
      },
    }
  }
  const summary = stateSummary(data.return)
  return {
    kind: 'ret',
    ret: {
      jid,
      minion: m[3],
      fun,
      args: JSON.stringify(data.fun_args ?? []),
      saltUser: typeof data.user === 'string' ? data.user : null,
      shakerUser: typeof meta.salt_shaker_user === 'string' ? meta.salt_shaker_user : null,
      ret: serialize(data.return),
      retcode: typeof data.retcode === 'number' ? data.retcode : null,
      success: typeof data.success === 'boolean' ? data.success : null,
      summary: summary ? JSON.stringify({ ok: summary.ok, changed: summary.changed, pending: summary.pending, failed: summary.failed }) : null,
      returnedAt: stamp(data._stamp),
    },
  }
}

/** Splits an SSE text buffer into complete `data:` payloads and the unconsumed rest. */
export function takeSseData(buf: string): { payloads: string[]; rest: string } {
  const payloads: string[] = []
  let idx
  while ((idx = buf.indexOf('\n\n')) >= 0) {
    const frame = buf.slice(0, idx)
    buf = buf.slice(idx + 2)
    const data = frame
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n')
    if (data) payloads.push(data)
  }
  return { payloads, rest: buf }
}

export interface StreamStatus {
  state: 'stopped' | 'connecting' | 'connected'
  since: Date | null
  lastEventAt: Date | null
  lastError: string | null
}

// events waiting to be written; past this (the database is far behind) new ones are dropped
const MAX_QUEUED = 50_000
// events written together at most
const MAX_BATCH = 2000

// what a repeated return replaces
const RETURN_COLUMNS = ['ret', 'retcode', 'success', 'summary', 'returnedAt'] as const

function* chunks<T>(list: T[], size: number) {
  for (let i = 0; i < list.length; i += size) yield list.slice(i, i + size)
}

export class HistoryRecorder {
  private db: Db
  private schema: Schema
  private bus: Pick<EventHub, 'subscribe'>
  private retentionDays: number
  private auditDays: number
  private leave: (() => void) | null = null
  private timers: ReturnType<typeof setInterval>[] = []
  private eventListeners: Array<(tag: string, data: Record<string, unknown>) => void> = []
  private returnListeners: Array<(r: JobRet) => void> = []
  private queue: Array<[string, Record<string, unknown>]> = []
  private draining = false
  private dropped = 0
  private salt: Pick<SaltService, 'call'> | null
  /** the newest jid seen on the bus */
  private seen: string | null = null
  /** where the jobs missed since the stream was last followed begin, once it's back */
  private gapFrom: Promise<string | null> | null = null
  private catching: Promise<void> | null = null
  /** how far the master's jids are ahead of UTC, from the last "new" event */
  private offsetMs = 0

  /** `salt` reads the jobs missed while the stream was down back from the master's job cache. */
  constructor(db: Db, schema: Schema, bus: Pick<EventHub, 'subscribe'>, retentionDays: number, auditDays = 0, salt: Pick<SaltService, 'call'> | null = null) {
    this.db = db
    this.schema = schema
    this.bus = bus
    this.retentionDays = retentionDays
    this.auditDays = auditDays
    this.salt = salt
  }

  /** Called for every master event, before filtering. */
  onEvent(fn: (tag: string, data: Record<string, unknown>) => void) {
    this.eventListeners.push(fn)
  }

  /** Called for every job return that is recorded. */
  onReturn(fn: (r: JobRet) => void) {
    this.returnListeners.push(fn)
  }

  /** Safe to call again after stop() (the leader may lose and regain its lease). */
  start() {
    if (this.leave) return
    // what ran while nobody here followed the bus starts after the newest job recorded; asked
    // before subscribing, so jobs recorded once the stream is back don't move it
    const { job } = this.schema
    this.gapFrom = this.db
      .select({ newest: sql<string | null>`max(${job.jid})` })
      .from(job)
      .then(([r]) => {
        const newest = r?.newest ?? null
        if (newest && (!this.seen || newest > this.seen)) this.seen = newest
        return newest
      })
    this.leave = this.bus.subscribe(
      (e) => this.enqueue(e.tag, e.data),
      () => {
        // the stream broke: what follows the newest job seen is missed until it's back
        if (!this.gapFrom) this.gapFrom = Promise.resolve(this.seen)
      },
      () => void this.catchUp(),
    )
    void this.prune()
    this.timers.push(setInterval(() => void this.prune(), 6 * 3600_000))
  }

  stop() {
    this.leave?.()
    this.leave = null
    this.gapFrom = null
    this.queue = []
    this.timers.forEach(clearInterval)
    this.timers = []
  }

  /**
   * Events are written in the order they came (a job's "new" before its returns), without making
   * the stream wait for the database: browsers read the same stream. What arrives while a write is
   * under way goes into the next one together, so a job returning from hundreds of minions takes a
   * handful of statements instead of several for every minion.
   */
  private enqueue(tag: string, data: Record<string, unknown>) {
    const jid = tag.match(/^salt\/job\/(\d{20})\//)?.[1]
    if (jid && (!this.seen || jid > this.seen)) this.seen = jid
    if (this.queue.length >= MAX_QUEUED) {
      if (this.dropped++ % 1000 === 0) console.warn(`history: the database is not keeping up, dropping events (${this.dropped} so far)`)
      return
    }
    this.queue.push([tag, data])
    if (!this.draining) void this.drain()
  }

  private async drain() {
    this.draining = true
    try {
      while (this.queue.length) {
        const batch = this.queue.splice(0, MAX_BATCH)
        try {
          await this.recordAll(batch)
          for (const [tag, data] of batch) this.learnOffset(tag, data)
        } catch (err) {
          // one bad event must not lose the others: write them one by one to find it
          for (const [tag, data] of batch) {
            try {
              await this.recordAll([[tag, data]], { events: false })
            } catch (e) {
              console.warn('history: could not record event', e)
            }
          }
          if (batch.length > 1) console.warn('history: a batch of events failed, recorded them one by one', err)
        }
      }
    } finally {
      this.draining = false
    }
  }

  async record(tag: string, data: Record<string, unknown>) {
    await this.recordAll([[tag, data]])
  }

  private learnOffset(tag: string, data: Record<string, unknown>) {
    const m = tag.match(/^salt\/job\/(\d{20})\/new$/)
    const at = m ? parseSaltStamp(data._stamp) : null
    const offset = m && at ? jidOffset(m[1], at) : null
    if (offset !== null) this.offsetMs = offset
  }

  /**
   * Records the jobs that ran while the stream was down, from the master's job cache: those
   * started after the newest one recorded before, and any of them still missing returns. Nobody
   * is notified about them: they're old news by now.
   */
  catchUp(): Promise<void> {
    if (this.catching) return this.catching
    const from = this.gapFrom
    this.gapFrom = null
    if (!from || !this.salt) return Promise.resolve()
    this.catching = (async () => {
      const after = await from
      // nothing recorded yet: history starts now rather than with the master's whole job cache
      if (!after) return
      const listed = (await this.salt!.call({ client: 'runner', fun: 'jobs.list_jobs' }, { lane: 'background', fresh: true })) as Record<string, ListedJob> | null
      if (!listed || typeof listed !== 'object') return
      const { jids, skipped } = jobsAfter(listed, after, worthRecording)
      if (!jids.length) return
      const { job } = this.schema
      const have = new Map<string, { minions: string | null; returned: number }>()
      for (const part of chunks(jids, 500)) for (const r of await this.db.select({ jid: job.jid, minions: job.minions, returned: job.returned }).from(job).where(inArray(job.jid, part))) have.set(r.jid, r)
      let recorded = 0
      for (const jid of jids) {
        if (!this.leave) return
        const known = have.get(jid)
        const expected = known?.minions ? (JSON.parse(known.minions) as unknown[]).length : 0
        if (known && expected > 0 && known.returned >= expected) continue
        const detail = (await this.salt!.call({ client: 'runner', fun: 'jobs.list_job', arg: [jid] }, { lane: 'background' })) as JobDetail | null
        if (!detail || typeof detail !== 'object') continue
        await this.recordAll(jobEvents(jid, detail, this.offsetMs), { events: false, returns: false })
        recorded++
      }
      if (recorded || skipped) console.log(`history: recorded ${recorded} job${recorded === 1 ? '' : 's'} that ran while the event stream was down${skipped ? `; ${skipped} older ones were left out` : ''}`)
    })()
      .catch((e) => {
        // try again on the next reconnect
        this.gapFrom ??= from
        console.warn('history: reading the jobs missed while the event stream was down failed', e instanceof Error ? e.message : e)
      })
      .finally(() => {
        this.catching = null
      })
    return this.catching
  }

  /**
   * Writes events in one go. `events: false` skips the event listeners (a retried batch whose
   * listeners already ran), `returns: false` the return listeners as well (jobs caught up on).
   */
  async recordAll(events: Array<[string, Record<string, unknown>]>, { events: notify = true, returns: notifyReturns = true } = {}) {
    const jobs = new Map<string, NewJob>()
    // the last return of a minion wins, as it would one after another
    const rets = new Map<string, JobRet>()
    for (const [tag, data] of events) {
      if (notify) for (const l of this.eventListeners) l(tag, data)
      const parsed = parseJobEvent(tag, data)
      if (parsed?.kind === 'new') {
        if (!jobs.has(parsed.job.jid)) jobs.set(parsed.job.jid, parsed.job)
      } else if (parsed) {
        const key = `${parsed.ret.jid}\0${parsed.ret.minion}`
        rets.delete(key)
        rets.set(key, parsed.ret)
      }
    }
    const { job, jobReturn } = this.schema
    if (jobs.size) await this.db.insert(job).values([...jobs.values()]).onConflictDoNothing()
    if (!rets.size) return
    const returns = [...rets.values()]

    // the "new" event may have been missed (server restarted mid-job): create the job from a return
    const firstOf = new Map<string, JobRet>()
    for (const r of returns) if (!firstOf.has(r.jid)) firstOf.set(r.jid, r)
    await this.db
      .insert(job)
      .values([...firstOf.values()].map((r) => ({ jid: r.jid, fun: r.fun, args: r.args, saltUser: r.saltUser, shakerUser: r.shakerUser, minions: JSON.stringify([r.minion]), dryRun: isDryRun(JSON.parse(r.args)), startedAt: r.returnedAt })))
      .onConflictDoNothing()
    const startedBy = new Map<string, string>()
    for (const r of returns) if (r.shakerUser && !startedBy.has(r.jid)) startedBy.set(r.jid, r.shakerUser)
    for (const [jid, who] of startedBy) await this.db.update(job).set({ shakerUser: who }).where(and(eq(job.jid, jid), isNull(job.shakerUser)))

    // a return can come twice (a minion that retried); the job's counts follow what is stored
    const before = new Map<string, { retcode: number | null; success: boolean | null }>()
    const jids = [...firstOf.keys()]
    const minions = [...new Set(returns.map((r) => r.minion))]
    for (const part of chunks(minions, 1000)) {
      const rows = await this.db
        .select({ jid: jobReturn.jid, minion: jobReturn.minion, retcode: jobReturn.retcode, success: jobReturn.success })
        .from(jobReturn)
        .where(and(inArray(jobReturn.jid, jids), inArray(jobReturn.minion, part)))
      for (const b of rows) before.set(`${b.jid}\0${b.minion}`, b)
    }

    const fresh = Object.fromEntries(RETURN_COLUMNS.map((k) => [k, sql`excluded.${sql.identifier(jobReturn[k].name)}`]))
    for (const [i, part] of [...chunks(returns, 250)].entries()) {
      // SQLite writes without letting go of the event loop: give requests a turn between chunks
      if (i) await new Promise((r) => setImmediate(r))
      await this.db
        .insert(jobReturn)
        .values(part.map((r) => ({ jid: r.jid, minion: r.minion, ret: r.ret, retcode: r.retcode, success: r.success, summary: r.summary, returnedAt: r.returnedAt })))
        .onConflictDoUpdate({ target: [jobReturn.jid, jobReturn.minion], set: fresh })
    }

    const counts = new Map<string, { returned: number; failed: number }>()
    for (const [key, r] of rets) {
      const b = before.get(key)
      const c = counts.get(r.jid) ?? { returned: 0, failed: 0 }
      c.returned += b ? 0 : 1
      c.failed += Number(returnFailed(r)) - Number(!!b && returnFailed(b))
      counts.set(r.jid, c)
    }
    for (const [jid, c] of counts) {
      if (c.returned || c.failed) await this.db.update(job).set({ returned: sql`${job.returned} + ${c.returned}`, failed: sql`${job.failed} + ${c.failed}` }).where(eq(job.jid, jid))
    }
    if (notifyReturns) for (const r of returns) for (const l of this.returnListeners) l(r)
  }

  /** Old jobs, and old audit entries when AUDIT_RETENTION_DAYS is set. Runs on the leader only. */
  async prune() {
    try {
      const audit = await pruneAudit(this.db, this.schema, this.auditDays)
      if (audit) console.log(`audit: pruned ${audit} entries older than ${this.auditDays} day${this.auditDays === 1 ? '' : 's'}`)
    } catch (err) {
      console.warn('audit: prune failed', err)
    }
    try {
      const cutoff = new Date(Date.now() - this.retentionDays * 86400_000)
      const { job, jobReturn } = this.schema
      const old = await this.db.select({ jid: job.jid }).from(job).where(lt(job.startedAt, cutoff)).limit(5000)
      if (old.length === 0) return
      const jids = old.map((o) => o.jid)
      await this.db.delete(jobReturn).where(inArray(jobReturn.jid, jids))
      await this.db.delete(job).where(inArray(job.jid, jids))
      console.log(`history: pruned ${jids.length} jobs older than ${this.retentionDays} days`)
    } catch (err) {
      console.warn('history: prune failed', err)
    }
  }
}
