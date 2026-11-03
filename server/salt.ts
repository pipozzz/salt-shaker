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

/**
 * salt-api client for the server's service account. Users never see this token; the server
 * checks their role, then calls salt-api on their behalf.
 */
export class SaltService {
  private cfg: Config['saltApi']
  private token: string | null = null
  private expire = 0
  private loggingIn: Promise<string> | null = null

  constructor(cfg: Config['saltApi']) {
    this.cfg = cfg
  }

  private async login() {
    const res = await fetch(`${this.cfg.url}/login`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: this.cfg.username, password: this.cfg.password, eauth: this.cfg.eauth }),
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

  async call(low: Record<string, unknown>): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.getToken(attempt > 0)
      let res: Response
      try {
        res = await fetch(`${this.cfg.url}/`, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Auth-Token': token },
          body: JSON.stringify([low]),
        })
      } catch (e) {
        throw unreachable(this.cfg.url, e)
      }
      if (res.status === 401 && attempt === 0) continue
      if (!res.ok) {
        const text = await res.text()
        throw new UpstreamError(text.match(/<p>([^<]+)<\/p>/)?.[1] ?? `salt-api returned ${res.status}`, res.status >= 500 ? 502 : res.status)
      }
      const body = (await res.json()) as { return: unknown[] }
      return body.return[0]
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
