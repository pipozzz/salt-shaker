import type { HistoryJob, MinionCompliance, MinionUpdates, VulnAccepted, VulnMinion, VulnSummary } from '../api/server'
import type { KeyList } from '../api/types'

/*
 * The fleet overview: a few numbers per area and a list of what needs someone's attention,
 * worst first, each pointing at the page where it gets fixed. Everything here is computed from
 * data the other pages already load; nothing is missing just because one source failed.
 */

export interface OverviewInput {
  now: number
  keys: KeyList | null
  /** null while manage.status is still asking the minions */
  status: { up: string[]; down: string[] } | null
  compliance: Record<string, MinionCompliance> | null
  updates: Record<string, MinionUpdates> | null
  vulns: { minions: VulnMinion[]; vulns: VulnSummary[]; accepted: VulnAccepted[] } | null
  /** failed jobs of the last day, newest first; null where there is no job history */
  failedJobs: HistoryJob[] | null
}

export type AttentionLevel = 'critical' | 'warning' | 'info'

export interface AttentionItem {
  id: string
  level: AttentionLevel
  title: string
  detail?: string
  /** where it gets looked at or fixed */
  to: string
  action: string
}

export interface Overview {
  minions: { accepted: number; up: number | null; down: number | null; pending: number }
  compliance: { checked: number; ok: number; drift: number; error: number; checkedAt: string | null } | null
  patches: { scanned: number; needing: number; packages: number; checkedAt: string | null } | null
  vulns: { critical: number; high: number; fixable: number; affected: number; scanned: number } | null
  jobs: { failed: number } | null
  attention: AttentionItem[]
}

const DAY = 86400_000
const LEVEL: Record<AttentionLevel, number> = { critical: 0, warning: 1, info: 2 }
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
/** "a, b, c and 4 more" */
const names = (ids: string[], max = 4) => (ids.length <= max ? ids.join(', ') : `${ids.slice(0, max).join(', ')} and ${ids.length - max} more`)
const latest = (dates: string[]) => dates.reduce<string | null>((a, d) => (!a || d > a ? d : a), null)

export function overview(i: OverviewInput): Overview {
  const accepted = new Set(i.keys?.minions ?? [])
  const attention: AttentionItem[] = []
  const add = (item: AttentionItem) => attention.push(item)

  // minions
  const down = i.status ? i.status.down.filter((m) => !accepted.size || accepted.has(m)).sort() : null
  const pending = i.keys?.minions_pre ?? []
  if (down?.length) add({ id: 'down', level: 'critical', title: `${plural(down.length, 'minion')} not responding`, detail: names(down), to: '/minions?status=down', action: 'See them' })
  if (pending.length) add({ id: 'keys', level: 'warning', title: `${plural(pending.length, 'new minion')} waiting for approval`, detail: names([...pending].sort()), to: '/keys', action: 'Review keys' })

  // compliance: each minion's latest check
  let compliance: Overview['compliance'] = null
  if (i.compliance) {
    const rows = Object.entries(i.compliance).filter(([m]) => !accepted.size || accepted.has(m))
    const failed = rows.filter(([, c]) => c.status === 'error').map(([m]) => m).sort()
    const drifted = rows.filter(([, c]) => c.status === 'drift').map(([m]) => m).sort()
    const checkedAt = latest(rows.map(([, c]) => c.checkedAt))
    compliance = { checked: rows.length, ok: rows.length - failed.length - drifted.length, drift: drifted.length, error: failed.length, checkedAt }
    if (failed.length) add({ id: 'compliance-error', level: 'critical', title: `Highstate fails on ${plural(failed.length, 'minion')}`, detail: names(failed), to: '/compliance', action: 'Check compliance' })
    if (drifted.length) add({ id: 'compliance-drift', level: 'warning', title: `${plural(drifted.length, 'minion')} drifted from ${drifted.length === 1 ? 'its' : 'their'} states`, detail: names(drifted), to: '/compliance', action: 'Remediate' })
    if (!rows.length || (checkedAt && i.now - Date.parse(checkedAt) > 7 * DAY))
      add({ id: 'compliance-stale', level: 'info', title: rows.length ? 'No compliance check in a week' : 'No compliance check yet', detail: 'A nightly schedule keeps drift from piling up.', to: '/compliance', action: 'Check now' })
  }

  // vulnerabilities, accepted ones already left out by the report
  let vulns: Overview['vulns'] = null
  if (i.vulns && i.vulns.minions.length) {
    const scanned = i.vulns.minions.filter((m) => !m.error)
    const by = (s: VulnSummary['severity']) => i.vulns!.vulns.filter((v) => v.severity === s)
    const fixableBad = i.vulns.vulns.filter((v) => (v.severity === 'critical' || v.severity === 'high') && v.fixable > 0)
    vulns = {
      critical: by('critical').length,
      high: by('high').length,
      fixable: i.vulns.vulns.filter((v) => v.fixable > 0).length,
      affected: scanned.filter((m) => m.counts.critical + m.counts.high + m.counts.medium + m.counts.low + m.counts.unknown > 0).length,
      scanned: scanned.length,
    }
    if (fixableBad.length) {
      const worst = fixableBad[0]
      add({
        id: 'vulns',
        level: fixableBad.some((v) => v.severity === 'critical') ? 'critical' : 'warning',
        title: `${plural(fixableBad.length, 'critical or high vulnerability', 'critical or high vulnerabilities')} with a fix`,
        detail: `${worst.id} in ${worst.packages.join(', ')} on ${plural(worst.fixable, 'minion')}${fixableBad.length > 1 ? `, and ${fixableBad.length - 1} more` : ''}`,
        to: '/patches',
        action: 'Upgrade',
      })
    }
    const lastScan = latest(i.vulns.minions.map((m) => m.scannedAt))
    if (lastScan && i.now - Date.parse(lastScan) > 7 * DAY) add({ id: 'vulns-stale', level: 'info', title: 'No vulnerability scan in a week', detail: 'New advisories only show up after a scan.', to: '/vulnerabilities', action: 'Scan' })
    const ending = i.vulns.accepted.filter((a) => a.expiresAt && Date.parse(a.expiresAt) - i.now < 7 * DAY && Date.parse(a.expiresAt) > i.now)
    if (ending.length) add({ id: 'acceptances', level: 'info', title: `${plural(ending.length, 'accepted risk')} ending within a week`, detail: names(ending.map((a) => a.id), 3), to: '/vulnerabilities?view=accepted', action: 'Review' })
  }

  // patches: each minion's latest scan
  let patches: Overview['patches'] = null
  if (i.updates) {
    const rows = Object.entries(i.updates).filter(([m]) => !accepted.size || accepted.has(m))
    const needing = rows.filter(([, u]) => u.packages > 0)
    patches = { scanned: rows.length, needing: needing.length, packages: needing.reduce((n, [, u]) => n + u.packages, 0), checkedAt: latest(rows.map(([, u]) => u.checkedAt)) }
    // the vulnerability item already says what's urgent; this is the rest
    if (needing.length && !attention.some((a) => a.id === 'vulns'))
      add({ id: 'patches', level: 'info', title: `${plural(needing.length, 'minion')} with pending upgrades`, detail: names(needing.map(([m]) => m).sort()), to: '/patches', action: 'Patch' })
  }

  // jobs
  let jobs: Overview['jobs'] = null
  if (i.failedJobs) {
    const recent = i.failedJobs.filter((j) => i.now - Date.parse(j.startedAt) < DAY)
    jobs = { failed: recent.length }
    if (recent.length) {
      const last = recent[0]
      add({
        id: 'jobs',
        level: 'warning',
        title: `${plural(recent.length, 'job')} failed in the last day`,
        detail: `Latest: ${last.fun} on ${last.target ?? '?'}, failed on ${plural(last.failed, 'minion')}`,
        to: '/jobs?result=failed',
        action: 'See jobs',
      })
    }
  }

  attention.sort((a, b) => LEVEL[a.level] - LEVEL[b.level])
  return {
    minions: { accepted: accepted.size, up: down ? accepted.size - down.length : null, down: down?.length ?? null, pending: pending.length },
    compliance,
    patches,
    vulns,
    jobs,
    attention,
  }
}
