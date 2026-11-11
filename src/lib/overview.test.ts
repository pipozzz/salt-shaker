import { describe, expect, it } from 'vitest'
import type { Change, HistoryJob, VulnMinion, VulnSummary } from '../api/server'
import { overview, type OverviewInput } from './overview'

const NOW = Date.UTC(2026, 10, 11, 12)
const ago = (hours: number) => new Date(NOW - hours * 3600_000).toISOString()
const counts = (c: Partial<VulnMinion['counts']> = {}) => ({ critical: 0, high: 0, medium: 0, low: 0, unknown: 0, fixable: 0, ...c })
const vuln = (id: string, severity: VulnSummary['severity'], fixable: number, packages = ['openssl']): VulnSummary => ({ id, cves: [], severity, score: null, summary: '', packages, minions: fixable || 1, fixable })
const job = (fun: string, hoursAgo: number, failed = 1): HistoryJob => ({ jid: `j${hoursAgo}`, fun, args: null, target: 'web-*', targetType: 'glob', saltUser: null, shakerUser: 'ann', minions: null, dryRun: false, startedAt: ago(hoursAgo), returned: 2, failed })

const base: OverviewInput = {
  now: NOW,
  keys: { minions: ['db-01', 'web-01', 'web-02'], minions_pre: [], minions_rejected: [], minions_denied: [] },
  status: { up: ['db-01', 'web-01', 'web-02'], down: [] },
  compliance: null,
  updates: null,
  vulns: null,
  failedJobs: null,
}

describe('overview', () => {
  it('is all clear for a healthy fleet, and leaves out what it has no data for', () => {
    const o = overview(base)
    expect(o.minions).toEqual({ accepted: 3, up: 3, down: 0, pending: 0 })
    expect([o.compliance, o.patches, o.vulns, o.jobs]).toEqual([null, null, null, null])
    expect(o.attention).toEqual([])
  })

  it("doesn't know who answers until manage.status is back", () => {
    expect(overview({ ...base, status: null }).minions).toEqual({ accepted: 3, up: null, down: null, pending: 0 })
  })

  it('puts what is down or failing first, then drift, then the rest', () => {
    const o = overview({
      ...base,
      keys: { ...base.keys!, minions_pre: ['new-02', 'new-01'] },
      status: { up: ['web-01', 'web-02'], down: ['db-01', 'gone-01'] },
      compliance: {
        'web-01': { status: 'drift', jid: '1', checkedAt: ago(2) },
        'web-02': { status: 'error', jid: '1', checkedAt: ago(2) },
        'db-01': { status: 'ok', jid: '1', checkedAt: ago(2) },
        // no longer accepted: left out
        'old-01': { status: 'drift', jid: '0', checkedAt: ago(200) },
      },
      failedJobs: [job('cmd.run', 1, 2), job('state.apply', 30)],
    })
    expect(o.attention.map((a) => [a.level, a.title, a.detail, a.to])).toEqual([
      ['critical', '1 minion not responding', 'db-01', '/minions?status=down'],
      ['critical', 'Highstate fails on 1 minion', 'web-02', '/compliance'],
      ['warning', '2 new minions waiting for approval', 'new-01, new-02', '/keys'],
      ['warning', '1 minion drifted from its states', 'web-01', '/compliance'],
      ['warning', '1 job failed in the last day', 'Latest: cmd.run on web-*, failed on 2 minions', '/jobs?result=failed'],
    ])
    expect(o.minions).toEqual({ accepted: 3, up: 2, down: 1, pending: 2 })
    expect(o.compliance).toEqual({ checked: 3, ok: 1, drift: 1, error: 1, checkedAt: ago(2) })
    expect(o.jobs).toEqual({ failed: 1 })
  })

  it('says so when compliance or the vulnerability scan is old', () => {
    const o = overview({
      ...base,
      compliance: { 'web-01': { status: 'ok', jid: '1', checkedAt: ago(8 * 24) } },
      vulns: { minions: [{ minion: 'web-01', jid: '2', scannedAt: ago(9 * 24), os: 'debian 12', ecosystem: 'Debian:12', packages: 400, error: null, counts: counts() }], vulns: [], accepted: [] },
    })
    expect(o.attention.map((a) => a.id)).toEqual(['compliance-stale', 'vulns-stale'])
    expect(overview({ ...base, compliance: {} }).attention.map((a) => a.title)).toEqual(['No compliance check yet'])
  })

  it('points at Patches for critical or high vulnerabilities with a fix, instead of listing every upgrade', () => {
    const o = overview({
      ...base,
      vulns: {
        minions: [
          { minion: 'web-01', jid: '2', scannedAt: ago(3), os: 'debian 12', ecosystem: 'Debian:12', packages: 400, error: null, counts: counts({ critical: 1, low: 2, fixable: 1 }) },
          { minion: 'db-01', jid: '2', scannedAt: ago(3), os: 'debian 12', ecosystem: 'Debian:12', packages: 400, error: null, counts: counts() },
          { minion: 'web-02', jid: '2', scannedAt: ago(3), os: null, ecosystem: null, packages: 0, error: 'not covered', counts: counts() },
        ],
        vulns: [vuln('CVE-1', 'critical', 2), vuln('CVE-2', 'high', 1, ['nginx']), vuln('CVE-3', 'low', 0)],
        accepted: [
          { id: 'CVE-9', vuln: null, packages: [], minions: 0, note: 'not exposed', acceptedBy: 'ann', acceptedAt: ago(100), expiresAt: ago(-48) },
          { id: 'CVE-8', vuln: null, packages: [], minions: 0, note: 'later', acceptedBy: 'ann', acceptedAt: ago(100), expiresAt: ago(-24 * 30) },
        ],
      },
      updates: { 'web-01': { packages: 3, jid: '3', checkedAt: ago(5) }, 'db-01': { packages: 0, jid: '3', checkedAt: ago(5) } },
    })
    expect(o.vulns).toEqual({ critical: 1, high: 1, fixable: 2, affected: 1, scanned: 2 })
    expect(o.patches).toEqual({ scanned: 2, needing: 1, packages: 3, checkedAt: ago(5) })
    expect(o.attention.map((a) => [a.id, a.level, a.detail])).toEqual([
      ['vulns', 'critical', 'CVE-1 in openssl on 2 minions, and 1 more'],
      ['acceptances', 'info', 'CVE-9'],
    ])
  })

  it('lists pending upgrades when nothing urgent does', () => {
    const o = overview({ ...base, updates: { 'web-01': { packages: 3, jid: '3', checkedAt: ago(5) }, 'web-02': { packages: 1, jid: '3', checkedAt: ago(5) } } })
    expect(o.attention).toMatchObject([{ id: 'patches', level: 'info', title: '2 minions with pending upgrades', detail: 'web-01, web-02', to: '/patches' }])
  })

  it('asks admins to decide waiting changes, and says when a rollout stopped', () => {
    const change = (id: number, status: Change['status'], extra: Partial<Change> = {}): Change => ({ id, reason: 'r', target: 'web-*', targetType: 'glob', fun: 'state.apply', args: { arg: [], kwarg: {} }, batchSize: '1', maxFailures: 0, status, requestedBy: 'olga', requestedById: 'u', requestedAt: ago(3), decidedBy: null, decidedAt: null, decisionNote: null, minions: null, batches: [], startedAt: null, finishedAt: null, error: null, ...extra })
    const changes = [change(3, 'pending'), change(2, 'stopped', { finishedAt: ago(2), error: '1 minion failed (web-02); at most 0 allowed' }), change(1, 'stopped', { finishedAt: ago(1), error: 'Stopped by olga' })]
    expect(overview({ ...base, changes, approver: true }).attention.map((a) => [a.level, a.title, a.to])).toEqual([
      ['critical', 'Change #2 stopped: state.apply on web-*', '/changes/2'],
      ['warning', '1 change waiting for approval', '/changes'],
    ])
    expect(overview({ ...base, changes, approver: false }).attention.map((a) => a.id)).toEqual(['change-2'])
  })
})
