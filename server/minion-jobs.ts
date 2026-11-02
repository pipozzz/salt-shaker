import { and, desc, eq, inArray, isNotNull, lt, or, sql } from 'drizzle-orm'
import type { Db, Schema } from './db'
import { complianceStatus } from './summaries'

/** LIKE pattern for a JSON-encoded minion id inside the job's minion list, with wildcards escaped. */
const minionNeedle = (id: string) => `%${JSON.stringify(id).replace(/[\\%_]/g, (c) => `\\${c}`)}%`

/**
 * Recorded jobs that targeted one minion or got a return from it, newest first, with that
 * minion's own result. `before` pages by start time (ms).
 */
export async function minionJobs(db: Db, schema: Schema, id: string, opts: { before?: number | null; limit?: number } = {}) {
  const t = schema.job
  const r = schema.jobReturn
  return db
    .select({
      jid: t.jid,
      fun: t.fun,
      args: t.args,
      target: t.target,
      targetType: t.targetType,
      saltUser: t.saltUser,
      shakerUser: t.shakerUser,
      dryRun: t.dryRun,
      startedAt: t.startedAt,
      returnedAt: r.returnedAt,
      retcode: r.retcode,
      success: r.success,
      summary: r.summary,
    })
    .from(t)
    .leftJoin(r, and(eq(r.jid, t.jid), eq(r.minion, id)))
    .where(
      and(
        opts.before ? lt(t.startedAt, new Date(opts.before)) : undefined,
        or(isNotNull(r.minion), sql`${t.minions} like ${minionNeedle(id)} escape '\\'`),
      ),
    )
    .orderBy(desc(t.startedAt))
    .limit(opts.limit ?? 50)
}

export interface MinionCompliance {
  status: 'ok' | 'drift' | 'error'
  jid: string
  checkedAt: Date
}

/**
 * Each minion's result in the latest compliance check (a dry-run highstate) it returned from,
 * looking back over the most recent `checks` checks. Minions that never returned are left out.
 */
export async function latestCompliance(db: Db, schema: Schema, checks = 50) {
  const t = schema.job
  const r = schema.jobReturn
  const jobs = await db
    .select({ jid: t.jid, startedAt: t.startedAt })
    .from(t)
    .where(and(eq(t.dryRun, true), or(eq(t.fun, 'state.apply'), eq(t.fun, 'state.highstate'))))
    .orderBy(desc(t.startedAt))
    .limit(checks)
  if (!jobs.length) return {}
  const startedAt = new Map(jobs.map((j) => [j.jid, j.startedAt]))
  const rets = await db.select({ jid: r.jid, minion: r.minion, summary: r.summary }).from(r).where(inArray(r.jid, [...startedAt.keys()]))
  const out: Record<string, MinionCompliance> = {}
  for (const x of rets) {
    const at = startedAt.get(x.jid)!
    if (out[x.minion] && out[x.minion].checkedAt >= at) continue
    out[x.minion] = { status: complianceStatus(x.summary), jid: x.jid, checkedAt: at }
  }
  return out
}
