import { describe, expect, it, vi } from 'vitest'
import { EventHub, type BusEvent } from './events'

const enc = new TextEncoder()
const frame = (tag: string, data: Record<string, unknown> = {}) => enc.encode(`tag: ${tag}\ndata: ${JSON.stringify({ tag, data })}\n\n`)

/** salt-api's /events: every connection is a stream the test writes to. */
function fakeSalt() {
  const conns: Array<{ send: (b: Uint8Array<ArrayBuffer>) => void; end: () => void; signal: AbortSignal }> = []
  let fail: string | null = null
  return {
    conns,
    failWith: (m: string | null) => (fail = m),
    events: async (signal: AbortSignal) => {
      if (fail) throw new Error(fail)
      let ctrl!: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>
      const body = new ReadableStream<Uint8Array<ArrayBuffer>>({ start: (c) => void (ctrl = c) })
      signal.addEventListener('abort', () => ctrl.error(signal.reason))
      conns.push({ send: (b) => ctrl.enqueue(b), end: () => ctrl.close(), signal })
      return body
    },
  }
}

const tick = () => new Promise((r) => setTimeout(r, 5))
async function readText(s: ReadableStream<Uint8Array>) {
  let out = ''
  for await (const c of s) out += new TextDecoder().decode(c)
  return out
}

describe('EventHub', () => {
  it('serves every listener from one connection and closes it after the last left', async () => {
    const salt = fakeSalt()
    const hub = new EventHub(salt, { idleMs: 10 })
    const a: BusEvent[] = []
    const b: string[] = []
    const offA = hub.subscribe((e) => a.push(e))
    const offB = hub.subscribe((e) => b.push(e.tag))
    expect(await hub.ready(100)).toBe(true)
    expect(salt.conns).toHaveLength(1)
    // a frame split across two chunks
    const f = frame('salt/job/1/new', { fun: 'test.ping' })
    salt.conns[0].send(f.slice(0, 10))
    salt.conns[0].send(f.slice(10))
    await tick()
    expect(a.map((e) => [e.tag, e.data])).toEqual([['salt/job/1/new', { fun: 'test.ping' }]])
    expect(new TextDecoder().decode(a[0].frame)).toBe(`data: ${JSON.stringify({ tag: 'salt/job/1/new', data: { fun: 'test.ping' } })}\n\n`)
    expect(b).toEqual(['salt/job/1/new'])
    expect(hub.status.state).toBe('connected')

    offA()
    offB()
    expect(salt.conns[0].signal.aborted).toBe(false)
    await new Promise((r) => setTimeout(r, 30))
    expect(salt.conns[0].signal.aborted).toBe(true)
    expect(hub.status.state).toBe('stopped')
  })

  it('stays connected when someone comes back before the idle time is up', async () => {
    const salt = fakeSalt()
    const hub = new EventHub(salt, { idleMs: 20 })
    hub.subscribe(() => undefined)()
    const off = hub.subscribe(() => undefined)
    await new Promise((r) => setTimeout(r, 40))
    expect(salt.conns).toHaveLength(1)
    expect(salt.conns[0].signal.aborted).toBe(false)
    off()
    hub.stop()
  })

  it('reconnects when salt-api closes the stream, and tells those who asked', async () => {
    const salt = fakeSalt()
    const hub = new EventHub(salt, { retryMs: 5 })
    const got: string[] = []
    const lost = vi.fn()
    hub.subscribe((e) => got.push(e.tag), lost)
    await hub.ready(100)
    salt.conns[0].end()
    await vi.waitFor(() => expect(salt.conns).toHaveLength(2))
    expect(lost).toHaveBeenCalledTimes(1)
    await hub.ready(100)
    salt.conns[1].send(frame('salt/key'))
    await tick()
    expect(got).toEqual(['salt/key'])
    hub.stop()
  })

  it('lets a tap see events without keeping the stream open', async () => {
    const salt = fakeSalt()
    const hub = new EventHub(salt)
    const seen: string[] = []
    hub.tap((e) => seen.push(e.tag))
    expect(salt.conns).toHaveLength(0)
    const off = hub.subscribe(() => {
      throw new Error('a broken listener')
    })
    await hub.ready(100)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    salt.conns[0].send(frame('salt/auth'))
    salt.conns[0].send(enc.encode('data: not json\n\n'))
    await tick()
    warn.mockRestore()
    expect(seen).toEqual(['salt/auth'])
    off()
    hub.stop()
  })

  it('streams to a browser until it leaves', async () => {
    const salt = fakeSalt()
    const hub = new EventHub(salt)
    const browser = new AbortController()
    const body = await hub.open(browser.signal)
    expect(hub.size).toBe(1)
    salt.conns[0].send(frame('salt/job/2/ret/web-01', { retcode: 0 }))
    await tick()
    browser.abort()
    expect(await readText(body)).toBe(`: connected\n\ndata: ${JSON.stringify({ tag: 'salt/job/2/ret/web-01', data: { retcode: 0 } })}\n\n`)
    expect(hub.size).toBe(0)
    hub.stop()
  })

  it('sends a keepalive comment to a browser while the bus is quiet, and stops when it leaves', async () => {
    const salt = fakeSalt()
    const hub = new EventHub(salt, { keepaliveMs: 40 })
    const browser = new AbortController()
    const body = await hub.open(browser.signal)
    const text = readText(body)
    // busy: the events keep the stream alive, no comment needed
    for (let i = 0; i < 4; i++) {
      salt.conns[0].send(frame('salt/auth'))
      await new Promise((r) => setTimeout(r, 5))
    }
    // quiet
    await new Promise((r) => setTimeout(r, 130))
    browser.abort()
    const out = await text
    expect(out.match(/data:/g)).toHaveLength(4)
    expect(out.slice(out.lastIndexOf('data:')).match(/: keepalive\n\n/g)!.length).toBeGreaterThanOrEqual(2)
    expect(out.slice(0, out.lastIndexOf('data:'))).not.toContain('keepalive')
    hub.stop()
  })

  it("ends a browser's stream when the connection to salt-api breaks", async () => {
    const salt = fakeSalt()
    const hub = new EventHub(salt, { retryMs: 1000 })
    const body = await hub.open(new AbortController().signal)
    salt.conns[0].end()
    expect(await readText(body)).toBe(': connected\n\n')
    hub.stop()
  })

  it("refuses a browser with salt-api's error when it can't be reached", async () => {
    const salt = fakeSalt()
    salt.failWith('Cannot reach salt-api at http://salt:8000: the connection was refused')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const hub = new EventHub(salt, { retryMs: 1000 })
    await expect(hub.open(new AbortController().signal, 50)).rejects.toMatchObject({ status: 502, message: expect.stringContaining('refused') })
    warn.mockRestore()
    expect(hub.size).toBe(0)
    hub.stop()
  })

  it('drops a browser that stopped reading instead of keeping everything for it', async () => {
    const salt = fakeSalt()
    const hub = new EventHub(salt)
    const body = await hub.open(new AbortController().signal)
    const one = frame('salt/auth')
    for (let i = 0; i < 2100; i++) salt.conns[0].send(one)
    await vi.waitFor(() => expect(hub.size).toBe(0))
    // what was buffered is still delivered, then the stream ends
    expect((await readText(body)).match(/data:/g)!.length).toBeLessThan(2100)
    hub.stop()
  })
})
