/**
 * Jobs that ran while this server wasn't following the event bus (salt-api restarted, the network
 * dropped, this server was down or another instance held the lease) are read back from the
 * master's job cache, so the history has no holes.
 */

/** The newest missed jobs a catch-up reads; older ones are left out rather than hold the master up. */
export const MAX_CATCH_UP = 200

/** What jobs.list_jobs says about each job. */
export interface ListedJob {
  Function?: unknown
  Arguments?: unknown
  Target?: unknown
  'Target-type'?: unknown
  User?: unknown
  Metadata?: unknown
}

/** What jobs.list_job says about one job: the listing plus who was targeted and their returns. */
export interface JobDetail extends ListedJob {
  Minions?: unknown
  Result?: unknown
}

/** A jid's timestamp read as UTC: 20261125092703685122 is 2026-11-25 09:27:03.685. */
export function jidTime(jid: string): number | null {
  const m = jid.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{3})\d{3}$/)
  if (!m) return null
  const [y, mo, d, h, mi, s, ms] = m.slice(1).map(Number)
  const t = Date.UTC(y, mo - 1, d, h, mi, s, ms)
  return Number.isNaN(t) ? null : t
}

/**
 * How far ahead of UTC the master's jids are, to the quarter hour: they're in its local time
 * (unless utc_jid is on), while event stamps are UTC. Learnt from a job's "new" event.
 */
export function jidOffset(jid: string, stamp: Date): number | null {
  const t = jidTime(jid)
  if (t === null) return null
  const quarter = 15 * 60_000
  // || 0: a clock a little ahead would give -0
  return Math.round((t - stamp.getTime()) / quarter) * quarter || 0
}

/**
 * The jobs started after `after` that are worth recording, oldest first: at most the newest
 * `MAX_CATCH_UP`, and how many were left out beyond that.
 */
export function jobsAfter(listed: Record<string, ListedJob>, after: string, keep: (fun: string, metadata: Record<string, unknown>) => boolean) {
  const jids = Object.entries(listed)
    .filter(([jid, j]) => /^\d{20}$/.test(jid) && jid > after && typeof j?.Function === 'string' && keep(j.Function, asObject(j.Metadata)))
    .map(([jid]) => jid)
    .sort()
  const skipped = Math.max(0, jids.length - MAX_CATCH_UP)
  return { jids: jids.slice(skipped), skipped }
}

const asObject = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/**
 * One job from jobs.list_job as the events the bus would have carried: its "new" event and a
 * return for each minion that answered. The job cache keeps no time per return, so the returns
 * carry the job's start.
 */
export function jobEvents(jid: string, job: JobDetail, offsetMs: number): Array<[string, Record<string, unknown>]> {
  if (typeof job.Function !== 'string') return []
  const t = jidTime(jid)
  const _stamp = new Date((t ?? Date.now()) - offsetMs).toISOString()
  const results = asObject(job.Result)
  const minions = Array.isArray(job.Minions) ? job.Minions.filter((m) => typeof m === 'string') : Object.keys(results)
  const metadata = asObject(job.Metadata)
  const common = { jid, fun: job.Function, user: typeof job.User === 'string' ? job.User : undefined, _stamp }
  const events: Array<[string, Record<string, unknown>]> = [
    [`salt/job/${jid}/new`, { ...common, arg: Array.isArray(job.Arguments) ? job.Arguments : [], tgt: job.Target, tgt_type: job['Target-type'], minions }],
  ]
  for (const [minion, r] of Object.entries(results)) {
    const ret = asObject(r)
    events.push([
      `salt/job/${jid}/ret/${minion}`,
      { ...common, id: minion, fun_args: Array.isArray(job.Arguments) ? job.Arguments : [], return: 'return' in ret ? ret.return : r, retcode: ret.retcode, success: ret.success, metadata },
    ])
  }
  return events
}
