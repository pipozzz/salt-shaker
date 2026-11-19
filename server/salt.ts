import { READ_ONLY } from '../src/lib/readonly'
import type { Config } from './config'

export class UpstreamError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

const UNTRUSTED = new Set(['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'])
// http:// against TLS, or https:// against plain HTTP
const WRONG_SCHEME = new Set(['UND_ERR_SOCKET', 'ECONNRESET', 'EPROTO', 'ERR_SSL_WRONG_VERSION_NUMBER'])

/** Why salt-api couldn't be reached, in words that say what to fix; fetch itself only says "fetch failed". */
function reason(url: string, err: unknown) {
  const cause = (err as { cause?: { code?: string; message?: string } } | null)?.cause
  const code = cause?.code ?? ''
  const host = new URL(url).hostname
  if (UNTRUSTED.has(code)) return `its TLS certificate isn't trusted (${code}). Mount the CA that signed it and set NODE_EXTRA_CA_CERTS to its path`
  if (code === 'CERT_HAS_EXPIRED') return 'its TLS certificate has expired'
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') return `its TLS certificate is not issued for ${host}`
  if (code === 'ECONNREFUSED') return 'the connection was refused; is salt-api running on that port?'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `the host name ${host} doesn't resolve`
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') return 'the connection timed out'
  if (WRONG_SCHEME.has(code)) return "the connection was dropped; check that the URL's scheme matches salt-api (https:// with TLS, http:// with disable_ssl)"
  return cause?.message ?? (err instanceof Error ? err.message : String(err))
}

export const unreachable = (url: string, err: unknown) => new UpstreamError(`Cannot reach salt-api at ${url}: ${reason(url, err)}`, 502)

export type Lane = 'interactive' | 'background'

export interface CallOptions {
  /** background: work nobody waits for (schedules, presence, runbooks); it queues apart from users' calls */
  lane?: Lane
  /** skip an answer kept from a moment ago (a Refresh button) */
  fresh?: boolean
}

/** Lets `limit` tasks run at once; the rest wait in line, and past `maxQueue` waiting are refused. */
export class Limiter {
  private active = 0
  private waiting: Array<() => void> = []

  constructor(
    private limit: number,
    private maxQueue: number,
  ) {}

  get stats() {
    return { active: this.active, waiting: this.waiting.length }
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active < this.limit) this.active++
    else {
      if (this.waiting.length >= this.maxQueue) throw new UpstreamError('salt-api is busy: too many calls are waiting for it', 503)
      // the finishing task hands its slot over, so `active` stays as it is
      await new Promise<void>((go) => this.waiting.push(go))
    }
    try {
      return await task()
    } finally {
      const next = this.waiting.shift()
      if (next) next()
      else this.active--
    }
  }
}

// reads every open page asks for; one answer serves everyone for this long
const KEEP_MS: Record<string, number> = {
  'wheel key.list_all': 5_000,
  'wheel key.finger': 5_000,
  'runner manage.status': 10_000,
  'runner cache.grains': 10_000,
  'runner jobs.active': 2_000,
  'runner jobs.list_jobs': 5_000,
}

/**
 * Whether a call's answer can be shared between callers, and for how long it is kept: null when it
 * can't be, 0 when only callers asking at the same moment share it. Only runner and wheel reads
 * qualify; calls to minions carry the user's name and are always made.
 */
export function shareFor(low: Record<string, unknown>): number | null {
  const { client, fun } = low
  if ((client !== 'runner' && client !== 'wheel') || typeof fun !== 'string') return null
  // salt.cmd runs anything on the master; only the version lookup is a plain read
  if (fun === 'salt.cmd') return Array.isArray(low.arg) && low.arg.length === 1 && low.arg[0] === 'test.version' && !low.kwarg ? 300_000 : null
  if (!READ_ONLY[client].test(fun)) return null
  return KEEP_MS[`${client} ${fun}`] ?? 0
}

/**
 * salt-api client for the server's service account. Users never see this token; the server
 * checks their role, then calls salt-api on their behalf.
 *
 * Every call goes through here, so this is also where the master is protected from the console
 * and users from each other: a call that gets no answer is given up on, users' calls and
 * background work wait in separate lines, and identical reads share one answer.
 */
export class SaltService {
  private cfg: Config['saltApi']
  private token: string | null = null
  private expire = 0
  private loggingIn: Promise<string> | null = null
  private timeoutMs: number
  private lanes: Record<Lane, Limiter>
  private inFlight = new Map<string, Promise<unknown>>()
  private kept = new Map<string, { at: number; fun: string; value: unknown }>()

  constructor(cfg: Config['saltApi']) {
    this.cfg = cfg
    this.timeoutMs = cfg.timeoutMs ?? 120_000
    this.lanes = { interactive: new Limiter(cfg.concurrency ?? 8, 200), background: new Limiter(cfg.backgroundConcurrency ?? 2, 1000) }
  }

  /** Calls running and waiting per lane, for /metrics. */
  get stats() {
    return { interactive: this.lanes.interactive.stats, background: this.lanes.background.stats }
  }

  /** The same client for work nobody waits for: its calls never take a slot from a user's. */
  background(): Pick<SaltService, 'call'> {
    return { call: (low, opts) => this.call(low, { ...opts, lane: 'background' }) }
  }

  /** Drops kept answers of functions starting with `prefix` (e.g. `key.` when a key changed). */
  forget(prefix = '') {
    for (const [k, v] of this.kept) if (v.fun.startsWith(prefix)) this.kept.delete(k)
  }

  private async login() {
    const res = await fetch(`${this.cfg.url}/login`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: this.cfg.username, password: this.cfg.password, eauth: this.cfg.eauth }),
      signal: AbortSignal.timeout(Math.min(this.timeoutMs, 30_000)),
    }).catch((e: unknown) => {
      throw unreachable(this.cfg.url, e)
    })
    if (!res.ok) throw new UpstreamError(`salt-api login for the service account failed (${res.status})`, 502)
    const body = (await res.json()) as { return: Array<{ token: string; expire: number }> }
    this.token = body.return[0].token
    this.expire = body.return[0].expire * 1000
    return this.token
  }

  /** A valid token, logging in again shortly before the old one expires. */
  async getToken(force = false) {
    if (!force && this.token && Date.now() < this.expire - 60_000) return this.token
    this.loggingIn ??= this.login().finally(() => (this.loggingIn = null))
    return this.loggingIn
  }

  /**
   * One lowstate call. The answer of a shared read may be the very object another caller got:
   * read it, don't change it.
   */
  async call(low: Record<string, unknown>, opts: CallOptions = {}): Promise<unknown> {
    const lane = this.lanes[opts.lane ?? 'interactive']
    const keepMs = shareFor(low)
    if (keepMs === null) {
      try {
        return await lane.run(() => this.send(low))
      } finally {
        // a key was accepted, rejected or deleted (or anything else changed): reads start over
        if (low.client === 'wheel') this.forget()
      }
    }
    const key = JSON.stringify(low)
    const hit = this.kept.get(key)
    if (hit && !opts.fresh && Date.now() - hit.at < keepMs) return hit.value
    const running = this.inFlight.get(key)
    if (running) return running
    const fun = String(low.fun)
    const asked = lane
      .run(() => this.send(low))
      .then((value) => {
        if (keepMs > 0) this.keep(key, { at: Date.now(), fun, value })
        return value
      })
      .finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, asked)
    return asked
  }

  private keep(key: string, entry: { at: number; fun: string; value: unknown }) {
    // targets differ per scoped user; drop what has gone stale rather than grow
    if (this.kept.size >= 200) for (const [k, v] of this.kept) if (entry.at - v.at > 300_000 || this.kept.size >= 200) this.kept.delete(k)
    this.kept.set(key, entry)
  }

  private async send(low: Record<string, unknown>): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.getToken(attempt > 0)
      try {
        const res = await fetch(`${this.cfg.url}/`, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Auth-Token': token },
          body: JSON.stringify([low]),
          signal: AbortSignal.timeout(this.timeoutMs),
        })
        if (res.status === 401 && attempt === 0) continue
        if (!res.ok) {
          const text = await res.text()
          throw new UpstreamError(text.match(/<p>([^<]+)<\/p>/)?.[1] ?? `salt-api returned ${res.status}`, res.status >= 500 ? 502 : res.status)
        }
        const body = (await res.json()) as { return: unknown[] }
        return body.return[0]
      } catch (e) {
        if (e instanceof UpstreamError) throw e
        // the master is stuck or the call is too big for a web request; don't hold the caller forever
        if ((e as { name?: string } | null)?.name === 'TimeoutError') throw new UpstreamError(`salt-api didn't answer ${String(low.fun)} within ${Math.round(this.timeoutMs / 1000)} s`, 504)
        throw unreachable(this.cfg.url, e)
      }
    }
    throw new UpstreamError('salt-api rejected the service account token', 502)
  }

  /** Opens the master's event stream (SSE) with the service token. */
  async events(signal: AbortSignal) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`${this.cfg.url}/events`, {
        headers: { Accept: 'text/event-stream', 'X-Auth-Token': await this.getToken(attempt > 0) },
        signal,
      }).catch((e: unknown) => {
        // stopping the stream on purpose isn't a connection problem
        throw signal.aborted ? e : unreachable(this.cfg.url, e)
      })
      if (res.status === 401 && attempt === 0) continue
      if (!res.ok || !res.body) throw new UpstreamError(`salt-api events returned ${res.status}`, 502)
      return res.body
    }
    throw new UpstreamError('salt-api rejected the service account token', 502)
  }
}
