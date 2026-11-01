import type { SaltEvent } from './types'

/**
 * Reads a Server-Sent Events stream with fetch (EventSource can't send headers) and
 * reconnects every few seconds until the returned function is called.
 */
export function streamEvents(url: string, init: RequestInit, onEvent: (e: SaltEvent) => void, onStatus: (connected: boolean) => void) {
  const ctrl = new AbortController()
  let stopped = false

  const connect = async () => {
    while (!stopped) {
      try {
        const res = await fetch(url, { ...init, headers: { Accept: 'text/event-stream', ...init.headers }, signal: ctrl.signal })
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
