import { and, count, desc, eq, gte, inArray, or, sql } from 'drizzle-orm'
import type { Db, Schema } from './db'
import type { SaltService } from './salt'
import { complianceCounts } from './summaries'

/** One Prometheus metric family: a gauge with labelled samples. */
export interface Gauge {
  name: string
  help: string
  samples: Array<{ labels?: Record<string, string>; value: number }>
}

const escapeLabel = (v: string) => v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')

/** Prometheus text exposition format (version 0.0.4). */
export function formatMetrics(gauges: Gauge[]) {
  const lines: string[] = []
  for (const g of gauges) {
    lines.push(`# HELP ${g.name} ${g.help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}`, `# TYPE ${g.name} gauge`)
    for (const s of g.samples) {
      const labels = Object.entries(s.labels ?? {})
      const l = labels.length ? `{${labels.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',')}}` : ''
      lines.push(`${g.name}${l} ${Number.isFinite(s.value) ? s.value : 'NaN'}`)
    }
  }
  return `${lines.join('\n')}\n`
}

const KEY_STATUS: Record<string, string> = { minions: 'accepted', minions_pre: 'pending', minions_rejected: 'rejected', minions_denied: 'denied' }

/** wheel key.list_all, unwrapped, as counts per key status. */
export function keyCounts(res: unknown) {
  const ret = (res as { data?: { return?: Record<string, string[]> } } | null)?.data?.return ?? {}
  return Object.entries(KEY_STATUS).map(([k, status]) => ({ labels: { status }, value: ret[k]?.length ?? 0 }))
}

const hasError = (summary: string | null) => {
  try {
    return !!summary && 'error' in (JSON.parse(summary) as object)
  } catch {
    return false
  }
}

const seconds = (d: Date | null | undefined) => (d ? Math.round(d.getTime() / 1000) : 0)

/**
 * Everything /metrics reports: the master's keys (one cheap wheel call), the latest compliance
 * check, recent job failures and the schedules, all read from what the server already records.
 */
export async function collectMetrics(deps: { db: Db; schema: Schema; salt: SaltService; version: string; isLeader: boolean; now?: Date }): Promise<Gauge[]> {
  const { db, schema, salt } = deps
  const now = deps.now ?? new Date()
  const gauges: Gauge[] = [
    { name: 'salt_shaker_info', help: 'Salt Shaker version.', samples: [{ labels: { version: deps.version }, value: 1 }] },
    { name: 'salt_shaker_events_leader', help: 'Whether this instance follows the event bus and records job history.', samples: [{ value: deps.isLeader ? 1 : 0 }] },
  ]

  let keys: Gauge['samples'] | null = null
  try {
    keys = keyCounts(await salt.call({ client: 'wheel', fun: 'key.list_all' }))
  } catch {
    // reported as salt_shaker_master_up 0
  }
  gauges.push({ name: 'salt_shaker_master_up', help: 'Whether salt-api answered the last call.', samples: [{ value: keys ? 1 : 0 }] })
  if (keys) gauges.push({ name: 'salt_shaker_minion_keys', help: 'Minion keys on the master by status.', samples: keys })

  // latest compliance check (a dry-run highstate)
  const j = schema.job
  const [last] = await db
    .select()
    .from(j)
    .where(and(eq(j.dryRun, true), or(eq(j.fun, 'state.apply'), eq(j.fun, 'state.highstate'))))
    .orderBy(desc(j.startedAt))
    .limit(1)
  if (last) {
    const rets = await db.select({ summary: schema.jobReturn.summary }).from(schema.jobReturn).where(eq(schema.jobReturn.jid, last.jid))
    const c = complianceCounts(rets, (JSON.parse(last.minions ?? '[]') as string[]).length)
    gauges.push(
      {
        name: 'salt_shaker_compliance_minions',
        help: 'Minions by result in the latest compliance check (dry-run highstate).',
        samples: Object.entries(c).map(([status, value]) => ({ labels: { status }, value })),
      },
      { name: 'salt_shaker_compliance_last_check_timestamp_seconds', help: 'When the latest compliance check started.', samples: [{ value: seconds(last.startedAt) }] },
    )
  }

  // job activity over the last 24 hours
  const since = new Date(now.getTime() - 24 * 3600_000)
  const r = schema.jobReturn
  const [jobs] = await db.select({ n: count() }).from(j).where(gte(j.startedAt, since))
  const [rets] = await db
    .select({
      n: count(),
      failed: sql<number>`coalesce(sum(case when ${r.retcode} <> 0 or not coalesce(${r.success}, true) then 1 else 0 end), 0)`.mapWith(Number),
    })
    .from(r)
    .where(gte(r.returnedAt, since))
  gauges.push(
    { name: 'salt_shaker_jobs_24h', help: 'Jobs started in the last 24 hours.', samples: [{ value: Number(jobs?.n ?? 0) }] },
    {
      name: 'salt_shaker_job_returns_24h',
      help: 'Minion returns in the last 24 hours by result.',
      samples: [
        { labels: { result: 'ok' }, value: Number(rets?.n ?? 0) - Number(rets?.failed ?? 0) },
        { labels: { result: 'failed' }, value: Number(rets?.failed ?? 0) },
      ],
    },
  )

  // schedules: when each last ran and whether that run had problems
  const schedules = await db.select().from(schema.schedule)
  if (schedules.length) {
    const lastJids = schedules.map((s) => s.lastJid).filter((x): x is string => !!x)
    const failedByJid = new Map<string, number>()
    if (lastJids.length) {
      const rows = await db
        .select({ jid: r.jid, failed: sql<number>`coalesce(sum(case when ${r.retcode} <> 0 or not coalesce(${r.success}, true) then 1 else 0 end), 0)`.mapWith(Number) })
        .from(r)
        .where(inArray(r.jid, lastJids))
        .groupBy(r.jid)
      for (const x of rows) failedByJid.set(x.jid, x.failed)
    }
    const labels = (s: (typeof schedules)[number]) => ({ schedule: s.name, kind: s.kind })
    gauges.push(
      { name: 'salt_shaker_schedule_enabled', help: 'Whether a schedule is enabled.', samples: schedules.map((s) => ({ labels: labels(s), value: s.enabled ? 1 : 0 })) },
      {
        name: 'salt_shaker_schedule_last_run_timestamp_seconds',
        help: 'When a schedule last started (0 if never).',
        samples: schedules.map((s) => ({ labels: labels(s), value: seconds(s.lastRunAt) })),
      },
      {
        name: 'salt_shaker_schedule_last_run_failed_minions',
        help: "Minions whose return failed in the schedule's last run.",
        samples: schedules.filter((s) => s.lastJid).map((s) => ({ labels: labels(s), value: failedByJid.get(s.lastJid!) ?? 0 })),
      },
      {
        name: 'salt_shaker_schedule_last_run_error',
        help: 'Whether the last run could not start (salt-api error, or no minions matched).',
        samples: schedules.filter((s) => s.lastRunAt).map((s) => ({ labels: labels(s), value: hasError(s.lastSummary) ? 1 : 0 })),
      },
    )
  }
  return gauges
}
