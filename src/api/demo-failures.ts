import { failureGroups } from '../lib/failures'
import { demoStateReturns } from './mock'
import type { FleetFailures } from './server'

/** Failures from the demo master's own state runs, grouped as the server would. */
export const demoFailures = (hours = 24): Promise<FleetFailures> => {
  const since = Date.now() - hours * 3600_000
  const returns = demoStateReturns(since)
  const out: FleetFailures = { groups: failureGroups(returns), runs: new Set(returns.map((r) => r.jid)).size, capped: false, since: new Date(since).toISOString(), hours }
  return new Promise((r) => setTimeout(() => r(out), 100))
}
