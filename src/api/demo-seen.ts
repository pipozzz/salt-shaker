import { demoMinionStatus } from './mock'
import type { MinionsSeen } from './server'

/*
 * The demo's last-seen record: every minion that answers was seen a moment ago, and cache-01,
 * which is down, last answered four months ago, as if it had been decommissioned and forgotten.
 */
const DAY = 86400_000
const started = Date.now() - 200 * DAY

export async function demoMinionsSeen(): Promise<MinionsSeen> {
  const now = Date.now()
  const { up, down } = demoMinionStatus()
  const seen: Record<string, string> = Object.fromEntries(up.map((id) => [id, new Date(now - 60_000).toISOString()]))
  for (const id of down) if (id === 'cache-01') seen[id] = new Date(now - 124 * DAY).toISOString()
  return { seen, since: new Date(started).toISOString(), checking: true }
}
