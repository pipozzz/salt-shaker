import { describe, expect, it } from 'vitest'
import { masterHostFrom } from './master'

describe('masterHostFrom', () => {
  it('takes the host of salt-api', () => {
    expect(masterHostFrom('https://sm.apps:8000')).toBe('sm.apps')
    expect(masterHostFrom('http://10.0.0.5:8000/')).toBe('10.0.0.5')
    expect(masterHostFrom('http://master:8000')).toBe('master')
  })
  it('skips loopback, which minions cannot reach', () => {
    for (const u of ['http://127.0.0.1:8000', 'http://localhost:8000', 'http://[::1]:8000', 'http://0.0.0.0:8000', 'http://salt.localhost']) expect(masterHostFrom(u), u).toBeNull()
  })
  it('resolves a relative URL against the page and ignores junk', () => {
    expect(masterHostFrom('/salt-api', 'https://salt.example.com/keys')).toBe('salt.example.com')
    expect(masterHostFrom('not a url')).toBeNull()
    expect(masterHostFrom('')).toBeNull()
  })
})
