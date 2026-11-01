import { describe, expect, it } from 'vitest'
import { isFailure, stateSummary } from '../components/ResultView'
import { classify } from './compliance'

// trimmed from a real `state.apply test=True` return on Salt 3007
const drifted = {
  'file_|-motd_|-/etc/motd_|-managed': { __id__: 'motd', __run_num__: 0, result: null, comment: 'The file /etc/motd is set to be changed', changes: { diff: '-hand edited\n+Managed by Salt' }, duration: 6 },
  'pkg_|-nginx_|-nginx_|-installed': { __id__: 'nginx', __run_num__: 1, result: true, comment: 'All specified packages are already installed', changes: {}, duration: 2 },
}
const clean = {
  'pkg_|-nginx_|-nginx_|-installed': { __id__: 'nginx', __run_num__: 0, result: true, comment: 'ok', changes: {}, duration: 2 },
}
const failed = {
  'service_|-nginx_|-nginx_|-running': { __id__: 'nginx', __run_num__: 0, result: false, comment: 'Job for nginx.service failed', changes: {}, duration: 40 },
}

describe('stateSummary', () => {
  it('counts ok / pending / changed / failed states', () => {
    expect(stateSummary(drifted)).toMatchObject({ ok: 1, pending: 1, changed: 0, failed: 0 })
    expect(stateSummary(failed)).toMatchObject({ failed: 1 })
  })

  it('returns null for non-state returns', () => {
    expect(stateSummary(true)).toBeNull()
    expect(stateSummary('not available')).toBeNull()
    expect(stateSummary({ openssl: '3.0.13' })).toBeNull()
    expect(stateSummary({})).toBeNull()
  })
})

describe('isFailure', () => {
  it('flags failed states, render errors and missing functions', () => {
    expect(isFailure(failed)).toBe(true)
    expect(isFailure(drifted)).toBe(false)
    expect(isFailure(['Rendering SLS base:webserver failed: Jinja error'])).toBe(true)
    expect(isFailure("'nope.nope' is not available.")).toBe(true)
    expect(isFailure(false)).toBe(true)
    expect(isFailure(true)).toBe(false)
  })
})

describe('classify', () => {
  const results = { 'web-01': drifted, 'web-02': clean, 'db-01': failed, 'edge-01': ['Rendering SLS failed'] }

  it('sorts minions into compliance buckets', () => {
    expect(classify('web-01', results, true)).toMatchObject({ status: 'drift', wouldChange: 1 })
    expect(classify('web-02', results, true).status).toBe('ok')
    expect(classify('db-01', results, true)).toMatchObject({ status: 'error', failed: 1 })
    // a non-state return means highstate never ran
    expect(classify('edge-01', results, true).status).toBe('error')
  })

  it('distinguishes waiting from no return', () => {
    expect(classify('mon-01', results, false).status).toBe('waiting')
    expect(classify('mon-01', results, true).status).toBe('noreturn')
  })
})
