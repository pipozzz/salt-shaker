import { and, desc, eq, gt, inArray, like, lt, or, sql } from 'drizzle-orm'
import type { Db, Schema } from './db'
import { returnFailed } from './history'
import { breather } from './prune'
import { visibleList, type Visible } from './visible'
import { toCsv } from '../src/lib/csv'

export const JOB_RESULTS = ['failed', 'dryrun'] as const
export type JobResult = (typeof JOB_RESULTS)[number]

/**
 * Recorded jobs, newest first, with how many minions returned and failed. `q` matches function,
 * target or user (or a whole jid); `result` keeps jobs where a minion failed, or dry runs.
 * `before` pages by start time (ms).
 */
export async function jobHistory(db: Db, schema: Schema, opts: { q?: string; result?: JobResult | null; before?: number | null; limit?: number; visible?: Visible } = {}) {
  if (opts.visible) return visibleHistory(db, schema, opts, opts.visible)
  return historyPage(db, schema, opts)
}

function historyPage(db: Db, schema: Schema, opts: { q?: string; result?: JobResult | null; before?: number | null; limit?: number }) {
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

type HistoryRow = Awaited<ReturnType<typeof historyPage>>[number]

// how many jobs a scoped user's page reads at a time while it looks for theirs
const SCAN = 1000

/**
 * The jobs that ran on any of a scoped user's minions, listing only those minions, with the
 * returns and failures counted on them alone. Jobs are read a page at a time until there are
 * enough, so a user whose minions rarely run anything doesn't hold the server up while the rest
 * of the history is read.
 */
async function visibleHistory(db: Db, schema: Schema, opts: { q?: string; result?: JobResult | null; before?: number | null; limit?: number }, v: ReadonlySet<string>) {
  const limit = opts.limit ?? 100
  const out: HistoryRow[] = []
  let before = opts.before ?? null
  // "failed" is decided on their minions below, not on the whole job's count
  const result = opts.result === 'failed' ? null : opts.result
  for (;;) {
    const page = await historyPage(db, schema, { ...opts, result, before, limit: SCAN })
    const mine = page.flatMap((row) => {
      const minions = visibleList(v, row.minions)
      return minions?.length ? [{ ...row, minions: JSON.stringify(minions), list: minions }] : []
    })
    if (mine.length) {
      const r = schema.jobReturn
      const counts = new Map<string, { returned: number; failed: number }>()
      for (let i = 0; i < mine.length; i += 400) {
        const part = mine.slice(i, i + 400)
        const rows = await db
          .select({ jid: r.jid, minion: r.minion, retcode: r.retcode, success: r.success })
          .from(r)
          .where(inArray(r.jid, part.map((x) => x.jid)))
        for (const x of rows) {
          if (!v.has(x.minion)) continue
          const c = counts.get(x.jid) ?? { returned: 0, failed: 0 }
          c.returned++
          if (returnFailed(x)) c.failed++
          counts.set(x.jid, c)
        }
      }
      for (const { list: _list, ...row } of mine) {
        const c = counts.get(row.jid) ?? { returned: 0, failed: 0 }
        if (opts.result === 'failed' && !c.failed) continue
        out.push({ ...row, ...c })
        if (out.length >= limit) return out
      }
    }
    if (page.length < SCAN) return out
    before = page[page.length - 1].startedAt.getTime()
    await breather()
  }
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
