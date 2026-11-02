import { describe, expect, it } from 'vitest'
import { resultsCsv, resultsJson, retryTargets } from './export'

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
