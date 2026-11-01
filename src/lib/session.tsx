import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { HttpTransport } from '../api/http'
import { MockTransport } from '../api/mock'
import { SaltApi } from '../api/salt'
import { currentUser, detectServer, ServerTransport, sessionFromMe, type ServerInfo } from '../api/server'
import type { SaltEvent, Session, Transport } from '../api/types'
import { makeCan, type Can } from './perms'
import { storage } from './storage'

/** live: browser talks to salt-api directly; server: through the Salt Shaker server; demo: mock. */
export type Mode = 'live' | 'demo' | 'server'

interface StoredSession extends Session {
  mode: Mode
  apiUrl: string
}

interface SessionCtx {
  /** undefined while probing; null when the UI runs without a server (direct salt-api). */
  server: ServerInfo | null | undefined
  refreshServer(): Promise<void>
  session: StoredSession | null
  salt: SaltApi | null
  login(opts: { mode: Mode; apiUrl: string; username: string; password: string; eauth: string }): Promise<void>
  logout(): void
  events: SaltEvent[]
  eventsConnected: boolean
  clearEvents(): void
  /** Get every event as it arrives (the events list may batch several into one render). */
  subscribe(fn: (e: SaltEvent) => void): () => void
  /** Whether the logged-in user's eauth perms allow a call (UI hint only). */
  can: Can
}

const Ctx = createContext<SessionCtx | null>(null)
const KEY = 'salt-shaker.session'
const MAX_EVENTS = 500

export const DEFAULT_API_URL = (import.meta.env.VITE_SALT_API_URL as string | undefined) ?? '/salt-api'

const mock = new MockTransport()
const serverTransport = new ServerTransport()
const transportFor = (mode: Mode, apiUrl: string): Transport => (mode === 'demo' ? mock : mode === 'server' ? serverTransport : new HttpTransport(apiUrl))

// server sessions live in an httpOnly cookie and are never written to storage
function loadSession(): StoredSession | null {
  const s = storage.get<StoredSession>(KEY)
  return s && s.mode !== 'server' && s.expire * 1000 > Date.now() ? s : null
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<StoredSession | null>(loadSession)
  const [server, setServer] = useState<ServerInfo | null | undefined>(undefined)

  const refreshServer = useCallback(async () => {
    const info = await detectServer()
    setServer(info)
    // restore a server session from its cookie, unless the user is in the demo
    if (info && !info.setupRequired) {
      const me = await currentUser().catch(() => null)
      if (me) setSession((s) => (s?.mode === 'demo' ? s : { ...sessionFromMe(me), mode: 'server', apiUrl: '' }))
    }
  }, [])
  useEffect(() => {
    void refreshServer()
  }, [refreshServer])
  const [events, setEvents] = useState<SaltEvent[]>([])
  const [eventsConnected, setConnected] = useState(false)
  const listeners = useRef(new Set<(e: SaltEvent) => void>())
  const subscribe = useCallback((fn: (e: SaltEvent) => void) => {
    listeners.current.add(fn)
    return () => void listeners.current.delete(fn)
  }, [])

  const logout = useCallback(() => {
    setSession((s) => {
      if (s) void transportFor(s.mode, s.apiUrl).logout(s.token)
      return null
    })
    storage.remove(KEY)
    setEvents([])
  }, [])

  const salt = useMemo(
    () => (session ? new SaltApi(transportFor(session.mode, session.apiUrl), session.token, logout) : null),
    [session, logout],
  )

  const can = useMemo(() => makeCan(session?.perms), [session])

  useEffect(() => {
    if (!salt) return
    return salt.events(
      (e) => {
        listeners.current.forEach((l) => l(e))
        setEvents((prev) => [{ ...e, data: { _received: Date.now(), ...e.data } }, ...prev].slice(0, MAX_EVENTS))
      },
      setConnected,
    )
  }, [salt])

  const login: SessionCtx['login'] = async ({ mode, apiUrl, username, password, eauth }) => {
    const s = await transportFor(mode, apiUrl).login(username, password, eauth)
    const stored = { ...s, mode, apiUrl }
    if (mode === 'server') storage.remove(KEY)
    else storage.set(KEY, stored)
    setSession(stored)
  }

  return (
    <Ctx.Provider value={{ server, refreshServer, session, salt, login, logout, events, eventsConnected, clearEvents: () => setEvents([]), subscribe, can }}>
      {children}
    </Ctx.Provider>
  )
}

export function useSession() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useSession outside SessionProvider')
  return ctx
}

/** For pages behind the login gate, where salt is always set. */
export function useSalt() {
  const { salt } = useSession()
  if (!salt) throw new Error('Not logged in')
  return salt
}

export function useCan() {
  return useSession().can
}
