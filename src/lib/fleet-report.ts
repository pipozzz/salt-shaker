import type { MinionCompliance, VulnMinion } from '../api/server'

/** The fleet report's sums, pure so they're tested on their own. */

const ATTENTION_LISTED = 12

/** How the latest compliance checks split, the share in compliance, and who needs a look. */
export function complianceCounts(minions: Record<string, Pick<MinionCompliance, 'status'>>, accepted: number) {
  const ids = Object.keys(minions).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const by = (s: MinionCompliance['status']) => ids.filter((id) => minions[id].status === s)
  const ok = by('ok').length
  const attention = [...by('error'), ...by('drift')]
  const checked = ids.length
  return {
    ok,
    drift: by('drift').length,
    error: by('error').length,
    unchecked: Math.max(0, accepted - checked),
    percent: checked ? Math.round((100 * ok) / checked) : null,
    attention: attention.slice(0, ATTENTION_LISTED),
    more: Math.max(0, attention.length - ATTENTION_LISTED),
  }
}

/** The minions with any critical or high vulnerability, the worst first. */
export function topVulnerable(minions: VulnMinion[], limit: number) {
  return minions
    .filter((m) => m.counts.critical || m.counts.high)
    .sort((a, b) => b.counts.critical - a.counts.critical || b.counts.high - a.counts.high || a.minion.localeCompare(b.minion, undefined, { numeric: true }))
    .slice(0, limit)
}

/** "+2 since last week", "−1 since last week" or "same as last week"; nothing to compare with says so. */
export function signed(now: number, before: number | null) {
  if (before === null) return 'no week-old scan to compare'
  if (now === before) return 'same as last week'
  return `${now > before ? '+' : '−'}${Math.abs(now - before)} since last week`
}
