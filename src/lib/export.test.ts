import { describe, expect, it } from 'vitest'
import { minionsCsv, resultsCsv, resultsJson, retryTargets } from './export'

const state = (result: boolean | null, changes = {}) => ({ result, changes, comment: '', __run_num__: 0 })
const results = {
  'web-02': { 'pkg_|-nginx_|-nginx_|-installed': state(true), 'file_|-conf_|-/etc/x_|-managed': state(false) },
  'web-01': { 'pkg_|-nginx_|-nginx_|-installed': state(true), 'file_|-conf_|-/etc/x_|-managed': state(null, { diff: '…' }) },
  'db-01': 'ERROR: something "broke", badly',
  'cache-01': true,
}

describe('retryTargets', () => {
  it('lists failed minions, then those that never returned', () => {
    expect(retryTargets(results, ['web-01', 'web-02', 'db-01', 'cache-01', 'mon-01'])).toEqual(['db-01', 'web-02', 'mon-01'])
  })

  it('is empty when everything returned fine', () => {
    expect(retryTargets({ a: true }, ['a'])).toEqual([])
  })
})

describe('resultsCsv', () => {
  it('writes one row per minion with state counts or the return', () => {
    const csv = resultsCsv(results, ['mon-01'])
    expect(csv.split('\r\n')).toEqual([
      'minion,status,ok,changed,pending,failed,return',
      'cache-01,ok,,,,,true',
      'db-01,failed,,,,,"ERROR: something ""broke"", badly"',
      'mon-01,no return,,,,,',
      'web-01,ok,1,0,1,0,',
      'web-02,failed,1,0,0,1,',
      '',
    ])
  })

  it('defuses spreadsheet formulas', () => {
    expect(resultsCsv({ 'x': '=HYPERLINK("http://evil")' })).toContain(`x,ok,,,,,"'=HYPERLINK(""http://evil"")"`)
  })
})

describe('resultsJson', () => {
  it('includes the job, returns and minions that did not return', () => {
    const doc = JSON.parse(resultsJson({ jid: '1', fun: 'test.ping', target: '*' }, { a: true }, ['a', 'b']))
    expect(doc).toEqual({ jid: '1', fun: 'test.ping', target: '*', returns: { a: true }, noReturn: ['b'] })
  })
})

describe('minionsCsv', () => {
  const g = { os: 'Ubuntu', osrelease: '24.04', kernelrelease: '6.8.0', ipv4: ['127.0.0.1', '10.0.0.5', '10.1.0.5'], num_cpus: 4, mem_total: 7962, virtual: 'kvm', roles: ['web', 'edge'], saltversion: '3007.1' }

  it('writes one row per minion with its grains', () => {
    const csv = minionsCsv([{ id: 'web-01', up: true, g }, { id: 'db-01', up: false, g: {} }, { id: 'x', g: {} }], false)
    expect(csv.split('\r\n')).toEqual([
      'minion,status,os,os_release,kernel,ipv4,cpus,memory_mb,virtual,roles,salt_version',
      'web-01,up,Ubuntu,24.04,6.8.0,10.0.0.5 10.1.0.5,4,7962,kvm,web edge,3007.1',
      'db-01,down,,,,,,,,,',
      'x,unknown,,,,,,,,,',
      '',
    ])
  })

  it('adds compliance and patch columns with the server', () => {
    const csv = minionsCsv([{ id: 'web-01', up: true, g, compliance: { status: 'drift', checkedAt: '2026-11-01T10:00:00.000Z' }, updates: { packages: 0, checkedAt: '2026-11-02T10:00:00.000Z' }, vulns: { error: null, scannedAt: '2026-11-03T10:00:00.000Z', counts: { critical: 1, high: 2, medium: 3, low: 1, unknown: 0, fixable: 5 } } }, { id: 'db-01', g: {} }], true)
    const [head, web, db] = csv.split('\r\n')
    expect(head.endsWith(',compliance,compliance_checked_at,pending_updates,updates_checked_at,vulnerabilities,critical,high,with_fix,inventory_at')).toBe(true)
    expect(web.endsWith(',drift,2026-11-01T10:00:00.000Z,0,2026-11-02T10:00:00.000Z,7,1,2,5,2026-11-03T10:00:00.000Z')).toBe(true)
    expect(db.endsWith(',unknown,,,,,,,,,,,,,,,,,,')).toBe(true)
  })
})
