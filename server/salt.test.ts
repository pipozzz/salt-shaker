import { describe, expect, it } from 'vitest'
import { unreachable } from './salt'

// what fetch throws: TypeError('fetch failed') with the real reason in cause.code
const failed = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) })
const url = 'https://salt.example.com:8000'

describe('unreachable', () => {
  it.each([
    ['DEPTH_ZERO_SELF_SIGNED_CERT', /isn't trusted \(DEPTH_ZERO_SELF_SIGNED_CERT\).*NODE_EXTRA_CA_CERTS/],
    ['SELF_SIGNED_CERT_IN_CHAIN', /NODE_EXTRA_CA_CERTS/],
    ['CERT_HAS_EXPIRED', /has expired/],
    ['ERR_TLS_CERT_ALTNAME_INVALID', /not issued for salt\.example\.com/],
    ['ECONNREFUSED', /refused/],
    ['ENOTFOUND', /salt\.example\.com doesn't resolve/],
    ['UND_ERR_CONNECT_TIMEOUT', /timed out/],
    ['ERR_SSL_WRONG_VERSION_NUMBER', /scheme/],
    ['UND_ERR_SOCKET', /scheme/],
  ])('explains %s', (code, message) => {
    const e = unreachable(url, failed(code))
    expect(e.message).toMatch(/^Cannot reach salt-api at https:\/\/salt\.example\.com:8000: /)
    expect(e.message).toMatch(message)
    expect(e.status).toBe(502)
  })

  it('falls back to the underlying message', () => {
    expect(unreachable(url, failed('EWHATEVER')).message).toBe(`Cannot reach salt-api at ${url}: EWHATEVER`)
    expect(unreachable(url, new Error('boom')).message).toBe(`Cannot reach salt-api at ${url}: boom`)
  })
})
