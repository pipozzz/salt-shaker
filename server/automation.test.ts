import { describe, expect, it } from 'vitest'
import { payloadFor } from './notify'
import { maskUrl } from './routes/automation'
import { dueAt, lowstateFor, nextRun } from './scheduler'
import { complianceCounts, complianceMessage, failureSummary, patchSummary } from './summaries'

const sum = (s: object | null) => ({ summary: s ? JSON.stringify(s) : null })

describe('summaries', () => {
  it('buckets compliance returns like the Compliance page', () => {
    const c = complianceCounts(
      [sum({ ok: 3, changed: 0, pending: 0, failed: 0 }), sum({ ok: 2, changed: 0, pending: 1, failed: 0 }), sum({ ok: 1, changed: 0, pending: 0, failed: 1 }), sum(null)],
      6,
    )
    expect(c).toEqual({ ok: 1, drift: 1, error: 2, noreturn: 2 })
  })

  it('aggregates patch scans by package', () => {
    const p = patchSummary(
      [{ ret: JSON.stringify({ openssl: '3.1', tzdata: '2026f' }) }, { ret: JSON.stringify({ tzdata: '2026f' }) }, { ret: JSON.stringify({}) }, { ret: JSON.stringify('error') }],
      5,
    )
    expect(p).toMatchObject({ scanned: 4, needUpdates: 2, packages: 2, noreturn: 1 })
    expect(p.top[0]).toEqual(['tzdata', 2])
  })

  it('lists failed minions', () => {
    const f = failureSummary(
      [
        { minion: 'a', retcode: 0, success: true },
        { minion: 'b', retcode: 2, success: true },
        { minion: 'c', retcode: null, success: false },
      ],
      4,
    )
    expect(f).toEqual({ returned: 3, failed: ['b', 'c'], noreturn: 1 })
  })

  it('words compliance results by severity', () => {
    expect(complianceMessage('n', '*', { ok: 3, drift: 0, error: 0, noreturn: 0 }, '1').severity).toBe('info')
    expect(complianceMessage('n', '*', { ok: 2, drift: 1, error: 0, noreturn: 0 }, '1').severity).toBe('warning')
    expect(complianceMessage('n', '*', { ok: 2, drift: 0, error: 1, noreturn: 0 }, '1')).toMatchObject({ severity: 'error', path: '/jobs/1' })
  })
})

describe('notification payloads', () => {
  const msg = { title: 'cmd.run failed on 2 minions', lines: ['Minions: a, b'], severity: 'error' as const, path: '/jobs/1' }

  it('uses Slack incoming-webhook format with a link back', () => {
    expect(payloadFor('slack', 'job_failed', msg, 'https://salt.example.com')).toEqual({
      text: '🔴 *cmd.run failed on 2 minions*\nMinions: a, b\n<https://salt.example.com/jobs/1|Open in Salt Shaker>',
    })
  })

  it('sends structured JSON to generic webhooks', () => {
    expect(payloadFor('webhook', 'job_failed', msg, 'https://salt.example.com')).toMatchObject({
      source: 'salt-shaker',
      event: 'job_failed',
      severity: 'error',
      url: 'https://salt.example.com/jobs/1',
    })
  })

  it('masks webhook secrets for display', () => {
    expect(maskUrl('https://hooks.slack.com/services/T000/B000/XXXXsecretYYYY')).toBe('https://hooks.slack.com/…YYYY')
    expect(maskUrl('not a url')).toBe('…')
  })
})

describe('scheduler', () => {
  it('rejects invalid cron expressions', () => {
    expect(() => nextRun('every day')).toThrow()
    expect(nextRun('0 2 * * *', new Date(2026, 10, 1, 12, 0))).toEqual(new Date(2026, 10, 2, 2, 0))
  })

  it('is due one slot after the last run, or after creation', () => {
    const createdAt = new Date(2026, 10, 1, 12, 0)
    expect(dueAt({ cron: '0 * * * *', lastRunAt: null, createdAt })).toEqual(new Date(2026, 10, 1, 13, 0))
    expect(dueAt({ cron: '0 * * * *', lastRunAt: new Date(2026, 10, 1, 13, 0, 5), createdAt })).toEqual(new Date(2026, 10, 1, 14, 0))
  })

  it('builds the lowstate for each kind and tags it with the schedule', () => {
    const base = { id: 7, name: 'nightly', fun: null, args: null, target: 'web-*', targetType: 'glob' }
    expect(lowstateFor({ ...base, kind: 'compliance' })).toMatchObject({
      client: 'local_async',
      fun: 'state.apply',
      kwarg: { test: true },
      metadata: { salt_shaker_user: 'schedule:nightly', salt_shaker_schedule: 7 },
    })
    expect(lowstateFor({ ...base, kind: 'patches' })).toMatchObject({ fun: 'pkg.list_upgrades', kwarg: { refresh: true } })
    expect(lowstateFor({ ...base, kind: 'function', fun: 'saltutil.sync_all', args: JSON.stringify({ arg: [], kwarg: { refresh: true } }) })).toMatchObject({
      fun: 'saltutil.sync_all',
      kwarg: { refresh: true },
    })
  })
})
