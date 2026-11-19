import { and, desc, eq, gt, like, lt, or, sql } from 'drizzle-orm'
import type { Db, Schema } from './db'
import { toCsv } from '../src/lib/csv'

export const JOB_RESULTS = ['failed', 'dryrun'] as const
export type JobResult = (typeof JOB_RESULTS)[number]

/**
 * Recorded jobs, newest first, with how many minions returned and failed. `q` matches function,
 * target or user (or a whole jid); `result` keeps jobs where a minion failed, or dry runs.
 * `before` pages by start time (ms).
 */
export async function jobHistory(db: Db, schema: Schema, opts: { q?: string; result?: JobResult | null; before?: number | null; limit?: number } = {}) {
  const t = schema.job
  const q = opts.q?.trim().toLowerCase()
  return db
    .select({
      jid: t.jid,
      fun: t.fun,
      args: t.args,
      target: t.target,
      targetType: t.targetType,
      saltUser: t.saltUser,
      shakerUser: t.shakerUser,
      minions: t.minions,
      dryRun: t.dryRun,
      startedAt: t.startedAt,
      // counted when the returns were recorded, so this reads the job table alone
      returned: t.returned,
      failed: t.failed,
    })
    .from(t)
    .where(
      and(
        opts.before ? lt(t.startedAt, new Date(opts.before)) : undefined,
        q ? or(...[t.fun, t.target, t.shakerUser, t.saltUser].map((col) => like(sql`lower(${col})`, `%${q}%`)), eq(t.jid, q)) : undefined,
        opts.result === 'dryrun' ? eq(t.dryRun, true) : undefined,
        opts.result === 'failed' ? gt(t.failed, 0) : undefined,
      ),
    )
    .orderBy(desc(t.startedAt))
    .limit(opts.limit ?? 100)
}

/** Jobs as CSV, one row per job, arguments as JSON and times in ISO 8601 UTC. */
export function jobsCsv(rows: Awaited<ReturnType<typeof jobHistory>>) {
  return toCsv([
    ['jid', 'started_at', 'function', 'arguments', 'target', 'target_type', 'started_by', 'salt_user', 'dry_run', 'minions', 'returned', 'failed'],
    ...rows.map((r) => {
      let expected = r.returned
      try {
        const list = r.minions ? (JSON.parse(r.minions) as unknown) : null
        if (Array.isArray(list)) expected = Math.max(list.length, r.returned)
      } catch {
        // keep the number of returns
      }
      return [r.jid, r.startedAt.toISOString(), r.fun, r.args, r.target, r.targetType, r.shakerUser, r.saltUser, r.dryRun, expected, r.returned, r.failed]
    }),
  ])
}
