import { desc, eq, inArray } from 'drizzle-orm'
import type { Db, Schema } from './db'
import { complianceCounts, failureSummary, patchSummary } from './summaries'

/** How one run of a schedule ended, in the same buckets for every kind. */
export type RunStatus = 'ok' | 'changed' | 'failed' | 'noreturn' | 'running'

export interface ScheduleRun {
  jid: string
  startedAt: Date
  status: RunStatus
  /** e.g. "3 ok · 1 drifted · 0 errors · 0 no return" */
  detail: string
}

// matches the scheduler's deadline: until then missing returns mean "still running"
const RUNNING_MS = 15 * 60_000

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * The latest recorded runs of each schedule, oldest first, found by the user the scheduler
 * starts its jobs as (`schedule:<name>`). Renaming a schedule starts its list anew.
 */
export async function recentScheduleRuns(
  db: Db,
  schema: Schema,
  schedules: Array<{ name: string; kind: string }>,
  opts: { limit?: number; now?: Date } = {},
) {
  const limit = opts.limit ?? 10
  const now = opts.now ?? new Date()
  const t = schema.job
  const r = schema.jobReturn
  const out = new Map<string, ScheduleRun[]>()
  for (const s of schedules) {
    const jobs = await db
      .select({ jid: t.jid, minions: t.minions, startedAt: t.startedAt })
      .from(t)
      .where(eq(t.shakerUser, `schedule:${s.name}`))
      .orderBy(desc(t.startedAt))
      .limit(limit)
    if (!jobs.length) {
      out.set(s.name, [])
      continue
    }
    // only patch scans need the (large) return itself
    const returns = await db
      .select({ jid: r.jid, minion: r.minion, retcode: r.retcode, success: r.success, summary: r.summary, ret: s.kind === 'patches' ? r.ret : r.summary })
      .from(r)
      .where(inArray(r.jid, jobs.map((j) => j.jid)))
    const byJid = new Map<string, typeof returns>()
    for (const row of returns) byJid.set(row.jid, [...(byJid.get(row.jid) ?? []), row])
    out.set(
      s.name,
      jobs.reverse().map((j) => {
        const rows = byJid.get(j.jid) ?? []
        let expected = rows.length
        try {
          const list = j.minions ? (JSON.parse(j.minions) as unknown) : null
          if (Array.isArray(list)) expected = Math.max(list.length, rows.length)
        } catch {
          // keep the number of returns
        }
        return { jid: j.jid, startedAt: j.startedAt, ...runStatus(s.kind, rows, expected, now.getTime() - j.startedAt.getTime() < RUNNING_MS) }
      }),
    )
  }
  return out
}

/** A run's bucket and a one-line description of it. */
export function runStatus(
  kind: string,
  rows: Array<{ minion: string; retcode: number | null; success: boolean | null; summary: string | null; ret: string | null }>,
  expected: number,
  recent: boolean,
): { status: RunStatus; detail: string } {
  const missing = Math.max(0, expected - rows.length)
  const waiting = missing > 0 && recent
  let status: RunStatus
  let detail: string
  if (kind === 'compliance') {
    const c = complianceCounts(rows, expected)
    status = c.error ? 'failed' : c.drift ? 'changed' : 'ok'
    detail = `${c.ok} ok · ${c.drift} drifted · ${c.error} ${c.error === 1 ? 'error' : 'errors'}`
  } else if (kind === 'patches') {
    const p = patchSummary(rows, expected)
    const f = failureSummary(rows, expected)
    status = f.failed.length ? 'failed' : p.needUpdates ? 'changed' : 'ok'
    detail = p.needUpdates ? `${plural(p.needUpdates, 'minion')} with ${plural(p.packages, 'package')} to update` : `${plural(p.scanned, 'minion')} up to date`
    if (f.failed.length) detail += ` · ${f.failed.length} failed`
  } else {
    const f = failureSummary(rows, expected)
    status = f.failed.length ? 'failed' : 'ok'
    detail = `${rows.length - f.failed.length} ok · ${f.failed.length} failed`
  }
  if (waiting) return { status: 'running', detail: `${rows.length} of ${expected} returned so far` }
  if (missing) {
    detail += ` · ${missing} no return`
    if (status === 'ok') status = 'noreturn'
  }
  return { status, detail }
}
