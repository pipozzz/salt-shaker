import { and, desc, eq, isNotNull, lt, or, sql } from 'drizzle-orm'
import type { Db, Schema } from './db'

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
