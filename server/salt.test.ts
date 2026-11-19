import { afterEach, describe, expect, it, vi } from 'vitest'
import { Limiter, SaltService, shareFor, unreachable, UpstreamError } from './salt'

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

describe('Limiter', () => {
  it('runs a few at once, the rest in order, and refuses when too many wait', async () => {
    const lim = new Limiter(2, 1)
    const gates: Array<() => void> = []
    const order: number[] = []
    const task = (n: number) => lim.run(() => new Promise<void>((r) => gates.push(() => (order.push(n), r()))))
    const a = task(1)
    const b = task(2)
    const c = task(3)
    expect(lim.stats).toEqual({ active: 2, waiting: 1 })
    await expect(task(4)).rejects.toMatchObject({ status: 503 })
    gates[0]()
    await a
    // the third took over the first one's slot
    expect(lim.stats).toEqual({ active: 2, waiting: 0 })
    await Promise.resolve()
    gates[1]()
    gates[2]()
    await Promise.all([b, c])
    expect(order).toEqual([1, 2, 3])
    expect(lim.stats).toEqual({ active: 0, waiting: 0 })
  })

  it('frees the slot when a task fails', async () => {
    const lim = new Limiter(1, 5)
    await expect(lim.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(await lim.run(async () => 'ok')).toBe('ok')
  })
})

describe('shareFor', () => {
  it('shares runner and wheel reads only', () => {
    expect(shareFor({ client: 'wheel', fun: 'key.list_all' })).toBe(5000)
    expect(shareFor({ client: 'runner', fun: 'manage.status' })).toBe(10_000)
    expect(shareFor({ client: 'runner', fun: 'jobs.lookup_jid', jid: '1' })).toBe(0)
    expect(shareFor({ client: 'wheel', fun: 'key.accept', match: 'a' })).toBeNull()
    expect(shareFor({ client: 'local', fun: 'grains.items', tgt: '*' })).toBeNull()
    expect(shareFor({ client: 'runner_async', fun: 'state.orchestrate' })).toBeNull()
  })

  it('shares salt.cmd only for the version lookup', () => {
    expect(shareFor({ client: 'runner', fun: 'salt.cmd', arg: ['test.version'] })).toBe(300_000)
    expect(shareFor({ client: 'runner', fun: 'salt.cmd', arg: ['cmd.run', 'reboot'] })).toBeNull()
    expect(shareFor({ client: 'runner', fun: 'salt.cmd', arg: ['test.version'], kwarg: { x: 1 } })).toBeNull()
  })
})

describe('SaltService', () => {
  afterEach(() => vi.unstubAllGlobals())

  const cfg = { url: 'http://salt:8000', username: 'u', password: 'p', eauth: 'pam' }
  /** salt-api that answers each call with a counter, once `release` lets it. */
  function fakeApi(hold = false) {
    const calls: Array<Record<string, unknown>> = []
    const held: Array<() => void> = []
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (url.endsWith('/login')) return json({ return: [{ token: 't', expire: Date.now() / 1000 + 3600 }] })
      const [low] = JSON.parse(String(init.body)) as Array<Record<string, unknown>>
      calls.push(low)
      const n = calls.length
      if (hold) await new Promise<void>((r) => held.push(r))
      return json({ return: [{ n }] })
    })
    return { calls, release: () => held.splice(0).forEach((r) => r()) }
  }

  it('asks once for identical reads made at the same time and keeps the answer a moment', async () => {
    const api = fakeApi(true)
    const salt = new SaltService(cfg)
    const keys = { client: 'wheel', fun: 'key.list_all' }
    const both = Promise.all([salt.call(keys), salt.call({ ...keys })])
    await vi.waitFor(() => expect(api.calls).toHaveLength(1))
    api.release()
    expect(await both).toEqual([{ n: 1 }, { n: 1 }])
    expect(await salt.call(keys)).toEqual({ n: 1 })
    expect(api.calls).toHaveLength(1)
  })

  it('asks again when told to, when a key changed, and after a wheel call that writes', async () => {
    fakeApi()
    const salt = new SaltService(cfg)
    const keys = { client: 'wheel', fun: 'key.list_all' }
    const status = { client: 'runner', fun: 'manage.status' }
    await salt.call(keys)
    await salt.call(status)
    expect(await salt.call(keys, { fresh: true })).toEqual({ n: 3 })
    salt.forget('key.')
    expect(await salt.call(keys)).toEqual({ n: 4 })
    expect(await salt.call(status)).toEqual({ n: 2 })
    await salt.call({ client: 'wheel', fun: 'key.accept', match: 'web-01' })
    expect(await salt.call(keys)).toEqual({ n: 6 })
    expect(await salt.call(status)).toEqual({ n: 7 })
  })

  it('never shares calls that run on minions or change something', async () => {
    const api = fakeApi()
    const salt = new SaltService(cfg)
    const run = { client: 'local_async', tgt: '*', fun: 'state.apply' }
    await Promise.all([salt.call(run), salt.call(run)])
    expect(api.calls).toHaveLength(2)
  })

  it('keeps background work out of the way of users', async () => {
    const api = fakeApi(true)
    const salt = new SaltService({ ...cfg, concurrency: 2, backgroundConcurrency: 1 })
    const bg = salt.background()
    const jobs = [1, 2, 3].map((n) => bg.call({ client: 'local_async', tgt: `m${n}`, fun: 'test.ping' }))
    const mine = salt.call({ client: 'local_async', tgt: 'web-01', fun: 'test.ping' })
    // one background call is out, two wait; the user's goes straight through
    await vi.waitFor(() => expect(api.calls.map((c) => c.tgt)).toEqual(['m1', 'web-01']))
    expect(salt.stats).toEqual({ interactive: { active: 1, waiting: 0 }, background: { active: 1, waiting: 2 } })
    for (let i = 0; i < 4; i++) {
      api.release()
      await new Promise((r) => setTimeout(r, 5))
    }
    await Promise.all([...jobs, mine])
    expect(salt.stats.background).toEqual({ active: 0, waiting: 0 })
  })

  it('gives up on a call that gets no answer', async () => {
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (url.endsWith('/login')) return new Response(JSON.stringify({ return: [{ token: 't', expire: Date.now() / 1000 + 3600 }] }))
      return new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))
    })
    const salt = new SaltService({ ...cfg, timeoutMs: 20 })
    const err = await salt.call({ client: 'runner', fun: 'jobs.list_jobs' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UpstreamError)
    expect(err).toMatchObject({ status: 504, message: "salt-api didn't answer jobs.list_jobs within 0 s" })
    // and the failure isn't kept
    expect(salt.stats.interactive).toEqual({ active: 0, waiting: 0 })
  })
})
