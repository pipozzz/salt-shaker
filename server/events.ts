import { takeSseData, type StreamStatus } from './history'
import { UpstreamError, type SaltService } from './salt'

export interface BusEvent {
  tag: string
  data: Record<string, unknown>
  /** the event as an SSE frame, encoded once for every browser */
  frame: Uint8Array
}

type Listener = (e: BusEvent) => void

// events a browser may fall behind by before it is dropped (it reconnects on its own)
const MAX_BUFFERED = 2000

// proxies and load balancers close a response that sends nothing for a while (often 60 s)
const KEEPALIVE_MS = 20_000

const enc = new TextEncoder()
const KEEPALIVE = enc.encode(': keepalive\n\n')

/**
 * This server's one connection to the master's event bus. salt-api keeps a thread busy for every
 * client of /events, so browsers don't get one each: the job recorder and every open tab listen
 * here. The connection is opened for the first listener and closed a while after the last left.
 */
export class EventHub {
  private salt: Pick<SaltService, 'events'>
  private idleMs: number
  private retryMs: number
  private keepaliveMs: number
  private listeners = new Map<Listener, { onLost?: () => void; onConnected?: () => void }>()
  private taps = new Set<Listener>()
  private ctrl: AbortController | null = null
  private idle: ReturnType<typeof setTimeout> | null = null
  private waiters = new Set<(connected: boolean) => void>()
  /** How following the event bus is going, for the System page. */
  status: StreamStatus = { state: 'stopped', since: null, lastEventAt: null, lastError: null }

  constructor(salt: Pick<SaltService, 'events'>, opts: { idleMs?: number; retryMs?: number; keepaliveMs?: number } = {}) {
    this.salt = salt
    this.idleMs = opts.idleMs ?? 60_000
    this.retryMs = opts.retryMs ?? 5000
    this.keepaliveMs = opts.keepaliveMs ?? KEEPALIVE_MS
  }

  /** How many listeners follow the stream (the recorder and open tabs). */
  get size() {
    return this.listeners.size
  }

  /**
   * Follows the bus until the returned function is called. `onLost` is called when the connection
   * to salt-api breaks, for listeners that would rather end than wait for it to come back.
   * `onConnected` is called each time the stream (re)connects, and right away if it already is:
   * what happened on the bus before then was missed.
   */
  subscribe(fn: Listener, onLost?: () => void, onConnected?: () => void) {
    this.listeners.set(fn, { onLost, onConnected })
    if (onConnected && this.status.state === 'connected') queueMicrotask(onConnected)
    if (this.idle) clearTimeout(this.idle)
    this.idle = null
    if (!this.ctrl) {
      this.ctrl = new AbortController()
      this.status = { ...this.status, state: 'connecting', since: new Date() }
      void this.follow(this.ctrl.signal)
    }
    return () => {
      if (!this.listeners.delete(fn) || this.listeners.size > 0 || this.idle) return
      // tabs come and go as people navigate; don't reconnect for each
      this.idle = setTimeout(() => this.stop(), this.idleMs)
      this.idle.unref?.()
    }
  }

  /** Sees the events while someone else keeps the stream open, without keeping it open itself. */
  tap(fn: Listener) {
    this.taps.add(fn)
    return () => void this.taps.delete(fn)
  }

  stop() {
    if (this.idle) clearTimeout(this.idle)
    this.idle = null
    this.ctrl?.abort()
    this.ctrl = null
    this.status = { ...this.status, state: 'stopped', since: new Date() }
    this.settle(false)
  }

  /** Whether the stream is connected, waiting up to `waitMs` for a connection being made. */
  ready(waitMs: number) {
    if (this.status.state === 'connected') return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      const done = (connected: boolean) => {
        clearTimeout(timer)
        this.waiters.delete(done)
        resolve(connected)
      }
      const timer = setTimeout(() => done(false), waitMs)
      this.waiters.add(done)
    })
  }

  private settle(connected: boolean) {
    for (const w of [...this.waiters]) w(connected)
  }

  /**
   * The stream for one browser, as SSE. Fails when salt-api can't be reached, and ends when the
   * connection to it breaks or the browser stops reading, so the browser shows it and reconnects.
   * A comment goes out when the bus is quiet, so proxies don't take the stream for a dead one.
   * `only` decides what this browser gets of each event: the frame as it is, another one, or none.
   */
  async open(signal: AbortSignal, waitMs = 5000, only?: (e: BusEvent) => Uint8Array | null): Promise<ReadableStream<Uint8Array>> {
    let out!: ReadableStreamDefaultController<Uint8Array>
    let leave = () => {}
    let beat: ReturnType<typeof setInterval> | undefined
    // when this browser was last sent anything
    let wrote = performance.now()
    const close = () => {
      clearInterval(beat)
      leave()
      try {
        out.close()
      } catch {
        // closed already
      }
    }
    const body = new ReadableStream<Uint8Array>({ start: (c) => void (out = c), cancel: () => (clearInterval(beat), leave()) }, { highWaterMark: MAX_BUFFERED })
    leave = this.subscribe((e) => {
      // a tab that stopped reading must not make the server keep everything for it
      const frame = only ? only(e) : e.frame
      if (!frame) return
      if ((out.desiredSize ?? 0) <= 0) close()
      else {
        out.enqueue(frame)
        wrote = performance.now()
      }
    }, close)
    signal.addEventListener('abort', close, { once: true })
    if (!(await this.ready(waitMs)) || signal.aborted) {
      close()
      throw new UpstreamError(this.status.lastError ?? 'The event stream from salt-api is not connected yet', 502)
    }
    // something to send right away, so the response starts and the browser knows it is connected
    out.enqueue(enc.encode(': connected\n\n'))
    wrote = performance.now()
    // checked a few times per period, so the stream is never quiet much longer than keepaliveMs;
    // a busy bus keeps it alive by itself
    beat = setInterval(() => {
      if (performance.now() - wrote < this.keepaliveMs) return
      if ((out.desiredSize ?? 0) <= 0) return close()
      out.enqueue(KEEPALIVE)
      wrote = performance.now()
    }, this.keepaliveMs / 4)
    beat.unref?.()
    return body
  }

  /** An event as an SSE frame, for one that is sent changed. */
  static frame(tag: string, data: Record<string, unknown>) {
    return enc.encode(`data: ${JSON.stringify({ tag, data })}\n\n`)
  }

  private emit(payload: string) {
    let e: { tag?: unknown; data?: unknown }
    try {
      e = JSON.parse(payload) as typeof e
    } catch {
      return
    }
    if (typeof e.tag !== 'string') return
    const data = e.data && typeof e.data === 'object' ? (e.data as Record<string, unknown>) : {}
    const frame = enc.encode(`${payload.split('\n').map((l) => `data: ${l}`).join('\n')}\n\n`)
    const event = { tag: e.tag, data, frame }
    for (const fn of [...this.taps, ...this.listeners.keys()]) {
      try {
        fn(event)
      } catch (err) {
        console.warn('events: a listener failed', err)
      }
    }
  }

  private async follow(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        const body = await this.salt.events(signal)
        this.status = { ...this.status, state: 'connected', since: new Date(), lastError: null }
        this.settle(true)
        for (const { onConnected } of [...this.listeners.values()]) onConnected?.()
        const reader = body.pipeThrough(new TextDecoderStream()).getReader()
        let buf = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          const { payloads, rest } = takeSseData(buf + value)
          buf = rest
          if (payloads.length) this.status.lastEventAt = new Date()
          for (const p of payloads) this.emit(p)
        }
        if (signal.aborted) return
        this.status = { ...this.status, state: 'connecting', since: new Date(), lastError: 'salt-api closed the event stream' }
      } catch (err) {
        if (signal.aborted) return
        const message = err instanceof Error ? err.message : String(err)
        this.status = { ...this.status, state: 'connecting', since: new Date(), lastError: message }
        console.warn('events: stream lost, retrying', message)
      }
      this.settle(false)
      for (const { onLost } of [...this.listeners.values()]) onLost?.()
      await new Promise((r) => setTimeout(r, this.retryMs))
    }
  }
}
