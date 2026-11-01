import { streamEvents } from './sse'
import { SaltError, type Lowstate, type SaltEvent, type Session, type Transport } from './types'

/** Talks to salt-api's rest_cherrypy netapi module. */
export class HttpTransport implements Transport {
  private baseUrl: string

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  private async post(path: string, body: unknown, token?: string) {
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(token ? { 'X-Auth-Token': token } : {}),
        },
        body: JSON.stringify(body),
      })
    } catch {
      throw new SaltError(`Cannot reach salt-api at ${this.baseUrl || window.location.origin}`)
    }
    if (res.status === 401) throw new SaltError(token ? 'Session expired' : 'Invalid credentials', 401)
    if (!res.ok) {
      const text = await res.text()
      // cherrypy error pages put the message in <pre id="traceback"> or <p>; fall back to status
      const msg = text.match(/<p>([^<]+)<\/p>/)?.[1] ?? text.slice(0, 200)
      throw new SaltError(msg || `salt-api returned ${res.status}`, res.status)
    }
    const json = (await res.json()) as { return: unknown[] }
    return json.return[0]
  }

  async login(username: string, password: string, eauth: string): Promise<Session> {
    return (await this.post('/login', { username, password, eauth })) as Session
  }

  async logout(token: string) {
    await this.post('/logout', {}, token).catch(() => undefined)
  }

  call(low: Lowstate, token: string) {
    return this.post('/', [low], token)
  }

  events(token: string, onEvent: (e: SaltEvent) => void, onStatus: (connected: boolean) => void) {
    // recent salt-api rejects ?token= on /events, so send the header via fetch
    return streamEvents(`${this.baseUrl}/events`, { headers: { 'X-Auth-Token': token } }, onEvent, onStatus)
  }
}
