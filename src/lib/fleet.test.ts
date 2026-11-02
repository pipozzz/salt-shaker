import { describe, expect, it } from 'vitest'
import { trimFleet } from './fleet'

describe('trimFleet', () => {
  it('keeps only the grains overviews use', () => {
    const out = trimFleet({
      'web-01': { id: 'web-01', os: 'Debian', osrelease: '13', ipv4: ['10.0.0.1'], saltversion: '3007.17', cpu_flags: ['aes', 'sse4'], pythonpath: ['/usr/lib'] },
    })
    expect(out).toEqual({ 'web-01': { id: 'web-01', os: 'Debian', osrelease: '13', ipv4: ['10.0.0.1'], saltversion: '3007.17' } })
  })

  it('drops minions whose entry is not a grains object', () => {
    expect(trimFleet({ a: 'Minion did not return', b: null, c: [1], d: { os: 'Rocky' } })).toEqual({ d: { os: 'Rocky' } })
  })

  it('handles an empty cache', () => {
    expect(trimFleet({})).toEqual({})
  })
})
