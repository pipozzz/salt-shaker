import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { HttpTransport } from '../api/http'
import { MockTransport } from '../api/mock'
import { SaltApi } from '../api/salt'
import type { SaltEvent, Session, Transport } from '../api/types'
import { storage } from './storage'

export type Mode = 'live' | 'demo'

interface StoredSession extends Session {
  mode: Mode
  apiUrl: string
}

interface SessionCtx {
  session: StoredSession | null
  salt: SaltApi | null
  login(opts: { mode: Mode; apiUrl: string; username: string; password: string; eauth: string }): Promise<void>
  logout(): void
  events: SaltEvent[]
  eventsConnected: boolean
  clearEvents(): void
}

const Ctx = createContext<SessionCtx | null>(null)
const KEY = 'salt-shaker.session'
const MAX_EVENTS = 500

export const DEFAULT_API_URL = (import.meta.env.VITE_SALT_API_URL as string | undefined) ?? '/salt-api'

const mock = new MockTransport()
const transportFor = (mode: Mode, apiUrl: string): Transport => (mode === 'demo' ? mock : new HttpTransport(apiUrl))

function loadSession(): StoredSession | null {
  const s = storage.get<StoredSession>(KEY)
  return s && s.expire * 1000 > Date.now() ? s : null
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<StoredSession | null>(loadSession)
  const [events, setEvents] = useState<SaltEvent[]>([])
  const [eventsConnected, setConnected] = useState(false)

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

  useEffect(() => {
    if (!salt) return
    return salt.events(
      (e) => setEvents((prev) => [{ ...e, data: { _received: Date.now(), ...e.data } }, ...prev].slice(0, MAX_EVENTS)),
      setConnected,
    )
  }, [salt])

  const login: SessionCtx['login'] = async ({ mode, apiUrl, username, password, eauth }) => {
    const s = await transportFor(mode, apiUrl).login(username, password, eauth)
    const stored = { ...s, mode, apiUrl }
    storage.set(KEY, stored)
    setSession(stored)
  }

  return (
    <Ctx.Provider value={{ session, salt, login, logout, events, eventsConnected, clearEvents: () => setEvents([]) }}>
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
