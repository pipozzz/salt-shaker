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
    // Recent salt-api rejects ?token= on /events, and EventSource cannot set headers,
    // so read the SSE stream with fetch and parse the frames ourselves.
    const ctrl = new AbortController()
    let stopped = false

    const connect = async () => {
      while (!stopped) {
        try {
          const res = await fetch(`${this.baseUrl}/events`, {
            headers: { Accept: 'text/event-stream', 'X-Auth-Token': token },
            signal: ctrl.signal,
          })
          if (!res.ok || !res.body) throw new Error(`events: ${res.status}`)
          onStatus(true)
          const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
          let buf = ''
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            buf += value
            let idx
            while ((idx = buf.indexOf('\n\n')) >= 0) {
              const frame = buf.slice(0, idx)
              buf = buf.slice(idx + 2)
              const data = frame
                .split('\n')
                .filter((l) => l.startsWith('data:'))
                .map((l) => l.slice(5).trimStart())
                .join('\n')
              if (!data) continue
              try {
                onEvent(JSON.parse(data) as SaltEvent)
              } catch {
                // ignore malformed frames
              }
            }
          }
        } catch {
          if (stopped) return
        }
        onStatus(false)
        await new Promise((r) => setTimeout(r, 3000))
      }
    }
    void connect()

    return () => {
      stopped = true
      ctrl.abort()
    }
  }
}
