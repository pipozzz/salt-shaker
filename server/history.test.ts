import { describe, expect, it } from 'vitest'
import { isDryRun, parseJobEvent, takeSseData } from './history'

// shapes captured from salt-api's /events on Salt 3007
const newEvent = {
  _stamp: '2026-11-01T19:11:51.725580',
  arg: ['common', { __kwarg__: true, test: true }],
  fun: 'state.apply',
  jid: '20261101191151725177',
  minions: ['web-01'],
  missing: [],
  tgt: 'web-01',
  tgt_type: 'glob',
  user: 'shaker',
}
const retEvent = {
  _stamp: '2026-11-01T19:11:52.101000',
  cmd: '_return',
  fun: 'state.apply',
  fun_args: ['common', { __kwarg__: true, test: true }],
  id: 'web-01',
  jid: '20261101191151725177',
  metadata: { salt_shaker_user: 'otto' },
  out: 'highstate',
  retcode: 0,
  return: {
    'file_|-motd_|-/etc/motd_|-managed': { result: null, changes: { diff: '…' }, comment: 'would change', __run_num__: 0 },
    'pkg_|-tools_|-tools_|-installed': { result: true, changes: {}, comment: 'ok', __run_num__: 1 },
  },
  success: true,
  user: 'shaker',
}

describe('parseJobEvent', () => {
  it('reads a new job', () => {
    const p = parseJobEvent('salt/job/20261101191151725177/new', newEvent)
    expect(p).toMatchObject({ kind: 'new', job: { jid: '20261101191151725177', fun: 'state.apply', target: 'web-01', saltUser: 'shaker', dryRun: true } })
    if (p?.kind === 'new') {
      expect(JSON.parse(p.job.minions)).toEqual(['web-01'])
      expect(p.job.startedAt.toISOString()).toBe('2026-11-01T19:11:51.725Z')
    }
  })

  it('reads a return with its state summary and the Salt Shaker user', () => {
    const p = parseJobEvent('salt/job/20261101191151725177/ret/web-01', retEvent)
    expect(p).toMatchObject({ kind: 'ret', ret: { minion: 'web-01', shakerUser: 'otto', retcode: 0, success: true } })
    if (p?.kind === 'ret') expect(JSON.parse(p.ret.summary!)).toEqual({ ok: 1, changed: 0, pending: 1, failed: 0 })
  })

  it('keeps minion ids that contain slashes or dots', () => {
    const p = parseJobEvent('salt/job/20261101191151725177/ret/edge/lon.01', retEvent)
    expect(p?.kind === 'ret' && p.ret.minion).toBe('edge/lon.01')
  })

  it('skips noise and non-job events', () => {
    expect(parseJobEvent('salt/job/20261101191151725177/new', { ...newEvent, fun: 'saltutil.find_job' })).toBeNull()
    expect(parseJobEvent('salt/job/20261101191151725177/new', { ...newEvent, fun: 'grains.items' })).toBeNull()
    expect(parseJobEvent('salt/job/20261101191151725177/ret/web-01', { ...retEvent, fun: 'runner.jobs.list_jobs' })).toBeNull()
    expect(parseJobEvent('salt/auth', { id: 'x', act: 'pend' })).toBeNull()
    expect(parseJobEvent('salt/job/20261101191151725177/publish', newEvent)).toBeNull()
    expect(parseJobEvent('20261101191151725177', newEvent)).toBeNull()
  })

  it('stores huge returns as a marker', () => {
    const p = parseJobEvent('salt/job/20261101191151725177/ret/web-01', { ...retEvent, return: 'x'.repeat(600 * 1024) })
    expect(p?.kind === 'ret' && JSON.parse(p.ret.ret)).toMatchObject({ _truncated: true })
  })
})

describe('isDryRun', () => {
  it('detects test=True among job arguments', () => {
    expect(isDryRun(['common', { __kwarg__: true, test: true }])).toBe(true)
    expect(isDryRun(['common', { __kwarg__: true, test: false }])).toBe(false)
    expect(isDryRun(['test=True'])).toBe(false)
    expect(isDryRun(null)).toBe(false)
  })
})

describe('takeSseData', () => {
  it('returns complete frames and keeps the partial rest', () => {
    const { payloads, rest } = takeSseData('retry: 400\n\ntag: a\ndata: {"x":1}\n\ntag: b\ndata: {"y"')
    expect(payloads).toEqual(['{"x":1}'])
    expect(rest).toBe('tag: b\ndata: {"y"')
  })
})
