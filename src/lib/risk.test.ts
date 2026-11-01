import { describe, expect, it } from 'vitest'
import { confirmLevel, isRisky } from './risk'

const many = ['a', 'b', 'c', 'd', 'e']

describe('isRisky', () => {
  it('flags functions that change minions', () => {
    for (const fun of ['cmd.run', 'cmd.script', 'state.apply', 'pkg.upgrade', 'service.restart', 'system.reboot', 'file.remove']) {
      expect(isRisky(fun, ''), fun).toBe(true)
    }
  })

  it('lets read-only functions through', () => {
    for (const fun of ['test.ping', 'grains.items', 'pkg.list_upgrades', 'service.status', 'state.show_sls', 'cmdx.run']) {
      expect(isRisky(fun, ''), fun).toBe(false)
    }
  })

  it('treats test=True dry runs as safe', () => {
    expect(isRisky('state.apply', 'webserver test=True')).toBe(false)
    expect(isRisky('state.apply', 'test=true')).toBe(false)
    expect(isRisky('state.apply', 'nottest=True')).toBe(true)
  })
})

describe('confirmLevel', () => {
  it('needs nothing for a single minion', () => {
    expect(confirmLevel('cmd.run', 'uptime', ['web-01'])).toBe('none')
  })

  it('asks for confirmation on a few minions and typing on many', () => {
    expect(confirmLevel('cmd.run', 'uptime', ['web-01', 'web-02'])).toBe('confirm')
    expect(confirmLevel('cmd.run', 'uptime', many)).toBe('type')
  })

  it('asks when the match count is unknown', () => {
    expect(confirmLevel('state.apply', '', null)).toBe('confirm')
  })

  it('never blocks safe calls', () => {
    expect(confirmLevel('test.ping', '', many)).toBe('none')
    expect(confirmLevel('state.apply', 'test=True', many)).toBe('none')
  })
})
