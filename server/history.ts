import { and, eq, inArray, isNull, lt } from 'drizzle-orm'
import { stateSummary } from '../src/lib/states'
import type { Db, Schema } from './db'
import type { SaltService } from './salt'

/**
 * Records jobs from the master's event bus into the database, so history outlives the
 * master's job cache (keep_jobs, 24h by default) and shows who ran what.
 */

// polling and lookups the UI (and manage.status) fire constantly; not worth keeping
const NOISE = new Set(['saltutil.find_job', 'sys.list_functions', 'grains.items', 'grains.item', 'grains.get', 'grains.ls', 'test.ping', 'test.version', 'pkg.version'])

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

const stamp = (s: unknown) => (typeof s === 'string' ? new Date(s.endsWith('Z') ? s : `${s}Z`) : new Date())

/** test=True arrives as a trailing {__kwarg__: true, test: true} argument. */
export const isDryRun = (args: unknown) =>
  Array.isArray(args) && args.some((a) => !!a && typeof a === 'object' && (a as Record<string, unknown>).__kwarg__ === true && (a as Record<string, unknown>).test === true)

function serialize(ret: unknown) {
  const json = JSON.stringify(ret ?? null)
  return json.length > MAX_RETURN_BYTES ? JSON.stringify({ _truncated: true, bytes: json.length }) : json
}

/** Turns one salt event into a row to store, or null if it isn't a job event worth keeping. */
export function parseJobEvent(tag: string, data: Record<string, unknown>): { kind: 'new'; job: NewJob } | { kind: 'ret'; ret: JobRet } | null {
  const m = tag.match(/^salt\/job\/(\d{20})\/(new|ret\/(.+))$/)
  if (!m) return null
  const fun = typeof data.fun === 'string' ? data.fun : null
  if (!fun || NOISE.has(fun) || fun.startsWith('runner.') || fun.startsWith('wheel.')) return null
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
  const meta = data.metadata && typeof data.metadata === 'object' ? (data.metadata as Record<string, unknown>) : {}
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

export class HistoryRecorder {
  private db: Db
  private schema: Schema
  private salt: SaltService
  private retentionDays: number
  private ctrl = new AbortController()
  private timers: ReturnType<typeof setInterval>[] = []
  private eventListeners: Array<(tag: string, data: Record<string, unknown>) => void> = []
  private returnListeners: Array<(r: JobRet) => void> = []

  constructor(db: Db, schema: Schema, salt: SaltService, retentionDays: number) {
    this.db = db
    this.schema = schema
    this.salt = salt
    this.retentionDays = retentionDays
  }

  /** Called for every master event, before filtering. */
  onEvent(fn: (tag: string, data: Record<string, unknown>) => void) {
    this.eventListeners.push(fn)
  }

  /** Called for every job return that is recorded. */
  onReturn(fn: (r: JobRet) => void) {
    this.returnListeners.push(fn)
  }

  start() {
    void this.listen()
    void this.prune()
    this.timers.push(setInterval(() => void this.prune(), 6 * 3600_000))
  }

  stop() {
    this.ctrl.abort()
    this.timers.forEach(clearInterval)
  }

  private async listen() {
    while (!this.ctrl.signal.aborted) {
      try {
        const body = await this.salt.events(this.ctrl.signal)
        const reader = body.pipeThrough(new TextDecoderStream()).getReader()
        let buf = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          const { payloads, rest } = takeSseData(buf + value)
          buf = rest
          for (const p of payloads) {
            try {
              const e = JSON.parse(p) as { tag: string; data: Record<string, unknown> }
              await this.record(e.tag, e.data)
            } catch (err) {
              console.warn('history: could not record event', err)
            }
          }
        }
      } catch (err) {
        if (this.ctrl.signal.aborted) return
        console.warn('history: event stream lost, retrying', err instanceof Error ? err.message : err)
      }
      await new Promise((r) => setTimeout(r, 5000))
    }
  }

  async record(tag: string, data: Record<string, unknown>) {
    for (const l of this.eventListeners) l(tag, data)
    const parsed = parseJobEvent(tag, data)
    if (!parsed) return
    const { job, jobReturn } = this.schema
    if (parsed.kind === 'new') {
      await this.db.insert(job).values(parsed.job).onConflictDoNothing()
      return
    }
    const r = parsed.ret
    // the "new" event may have been missed (server restarted mid-job): create the job from the return
    await this.db
      .insert(job)
      .values({ jid: r.jid, fun: r.fun, args: r.args, saltUser: r.saltUser, shakerUser: r.shakerUser, minions: JSON.stringify([r.minion]), dryRun: isDryRun(JSON.parse(r.args)), startedAt: r.returnedAt })
      .onConflictDoNothing()
    if (r.shakerUser) await this.db.update(job).set({ shakerUser: r.shakerUser }).where(and(eq(job.jid, r.jid), isNull(job.shakerUser)))
    const row = { jid: r.jid, minion: r.minion, ret: r.ret, retcode: r.retcode, success: r.success, summary: r.summary, returnedAt: r.returnedAt }
    await this.db
      .insert(jobReturn)
      .values(row)
      .onConflictDoUpdate({ target: [jobReturn.jid, jobReturn.minion], set: row })
    for (const l of this.returnListeners) l(r)
  }

  async prune() {
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
