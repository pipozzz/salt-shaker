import { history, parseStoredArgs } from '../api/server'
import { SaltError, type JobDetail } from '../api/types'

/**
 * A job and its returns: with the server, from its history (kept for weeks), else from the
 * master's job cache (about a day).
 */
export async function loadJobDetail(salt: { job: (jid: string) => Promise<JobDetail> }, fromServer: boolean, jid: string): Promise<JobDetail> {
  if (fromServer) {
    try {
      const { job, returns } = await history.job(jid)
      return {
        jid,
        Function: job.fun,
        Arguments: parseStoredArgs(job.args),
        Target: job.target ?? '',
        'Target-type': job.targetType ?? 'glob',
        User: job.shakerUser ?? job.saltUser ?? '',
        StartTime: job.startedAt,
        Minions: JSON.parse(job.minions ?? '[]') as string[],
        Result: Object.fromEntries(returns.map((r) => [r.minion, { return: r.ret, retcode: r.retcode ?? undefined, success: r.success ?? undefined }])),
      }
    } catch (e) {
      if (!(e instanceof SaltError && e.status === 404)) throw e
    }
  }
  const job = await salt.job(jid)
  // salt-api answers an unknown jid with an empty job
  if (!job.Function) throw new SaltError(`No job ${jid} is kept${fromServer ? '' : ": the master's job cache keeps jobs for about a day"}`, 404)
  return job
}

/** Each minion's return, keyed by minion. */
export const jobResults = (job: JobDetail | null | undefined) => Object.fromEntries(Object.entries(job?.Result ?? {}).map(([id, r]) => [id, r.return]))
