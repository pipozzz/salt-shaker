import { describe, expect, it } from 'vitest'
import { endQuietly, unreachable } from './salt'

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

describe('endQuietly', () => {
  const read = async (s: ReadableStream<Uint8Array>) => {
    const chunks: string[] = []
    for await (const c of s) chunks.push(new TextDecoder().decode(c))
    return chunks.join('')
  }

  it('passes the data through', async () => {
    const enc = new TextEncoder()
    const up = new ReadableStream<Uint8Array>({ start: (c) => (c.enqueue(enc.encode('data: 1\n\n')), c.close()) })
    expect(await read(endQuietly(up))).toBe('data: 1\n\n')
  })

  it('ends instead of erroring when the upstream fails (a browser left)', async () => {
    const enc = new TextEncoder()
    let pulls = 0
    const up = new ReadableStream<Uint8Array>({
      pull(c) {
        if (pulls++ === 0) c.enqueue(enc.encode('a'))
        else c.error('Error: aborted')
      },
    })
    expect(await read(endQuietly(up))).toBe('a')
  })
})
