import { and, desc, gte, inArray } from 'drizzle-orm'
import { failureGroups, STATE_FUNS, type RunReturn } from '../src/lib/failures'
import type { Db, Schema } from './db'

/** The most state runs a look back reads, so a busy week can't make it slow. */
export const MAX_RUNS = 500
const CHUNK = 400

const chunks = <T>(list: T[]) => Array.from({ length: Math.ceil(list.length / CHUNK) }, (_, i) => list.slice(i * CHUNK, (i + 1) * CHUNK))

function failedReturn(r: { retcode: number | null; success: boolean | null; summary: string | null }) {
  if ((r.retcode ?? 0) !== 0 || r.success === false) return true
  try {
    return ((r.summary ? (JSON.parse(r.summary) as { failed?: number }) : {}).failed ?? 0) > 0
  } catch {
    return false
  }
}

/**
 * What's failing in the state runs recorded over the last `hours`, grouped by state and error.
 * Only minions with a failed return are read in full, so a healthy fleet costs one small query.
 */
export async function fleetFailures(db: Db, schema: Schema, opts: { hours: number; now?: number }) {
  const t = schema.job
  const r = schema.jobReturn
  const since = new Date((opts.now ?? Date.now()) - opts.hours * 3600_000)
  const jobs = await db
    .select({ jid: t.jid, fun: t.fun, args: t.args, dryRun: t.dryRun })
    .from(t)
    .where(and(gte(t.startedAt, since), inArray(t.fun, [...STATE_FUNS])))
    .orderBy(desc(t.startedAt))
    .limit(MAX_RUNS)
  const byJid = new Map(jobs.map((j) => [j.jid, j]))
  const jids = [...byJid.keys()]

  const failing = new Set<string>()
  for (const part of chunks(jids)) {
    const rows = await db.select({ minion: r.minion, retcode: r.retcode, success: r.success, summary: r.summary }).from(r).where(inArray(r.jid, part))
    for (const row of rows) if (failedReturn(row)) failing.add(row.minion)
  }

  const returns: RunReturn[] = []
  for (const minions of chunks([...failing])) {
    for (const part of chunks(jids)) {
      const rows = await db
        .select({ jid: r.jid, minion: r.minion, ret: r.ret, returnedAt: r.returnedAt })
        .from(r)
        .where(and(inArray(r.jid, part), inArray(r.minion, minions)))
      for (const row of rows) {
        const job = byJid.get(row.jid)!
        let ret: unknown = null
        try {
          ret = row.ret ? JSON.parse(row.ret) : null
        } catch {
          ret = row.ret
        }
        returns.push({ jid: row.jid, fun: job.fun, args: job.args, dryRun: job.dryRun, minion: row.minion, ret, at: row.returnedAt.getTime() })
      }
    }
  }
  return { groups: failureGroups(returns), runs: jobs.length, capped: jobs.length === MAX_RUNS, since: since.toISOString() }
}
