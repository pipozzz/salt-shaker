import { demoJobHistory, demoPendingUpdates } from './mock'
import type { HistoryJob, MinionCompliance, MinionUpdates } from './server'

/*
 * What the server's job history would say about the demo fleet, for the overview: each minion's
 * latest compliance check (from the nightly schedule), its pending upgrades and the failed jobs of
 * the last day, which come from the simulated master's own history.
 */

const delay = <T>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 100))
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString()

export const demoOverview = {
  compliance: () =>
    delay<{ minions: Record<string, MinionCompliance> }>({
      // cache-01 is down, so the last check had nothing from it
      minions: Object.fromEntries(
        [
          ['web-01', 'drift'],
          ['web-02', 'drift'],
          ['db-01', 'drift'],
          ['mon-01', 'ok'],
          ['worker-01', 'ok'],
        ].map(([id, status]) => [id, { status: status as MinionCompliance['status'], jid: '', checkedAt: hoursAgo(10) }]),
      ),
    }),
  updates: () => delay<{ minions: Record<string, MinionUpdates> }>({ minions: demoPendingUpdates(hoursAgo(26)) }),
  failedJobs: () => delay<{ rows: HistoryJob[] }>({ rows: demoJobHistory(Date.now() - 86400_000).filter((j) => j.failed > 0) }),
}
