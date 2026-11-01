import { streamEvents } from './sse'
import { SaltError, type Lowstate, type SaltEvent, type Session, type Transport } from './types'

/** Talks to the Salt Shaker server (server/), which holds users and proxies salt-api. */

export interface ServerInfo {
  mode: 'server'
  setupRequired: boolean
}

export type Role = 'admin' | 'operator' | 'viewer'
export const ROLES: Role[] = ['admin', 'operator', 'viewer']

export interface Me {
  user: { id: string; name: string; username: string; role: Role }
  perms: unknown[]
  expiresAt: string | null
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      ...init,
      headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    })
  } catch {
    throw new SaltError('Cannot reach the Salt Shaker server')
  }
  const text = await res.text()
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  if (!res.ok) {
    const msg = (body.error as string) ?? (body.message as string) ?? `Request failed (${res.status})`
    throw new SaltError(msg, res.status)
  }
  return body as T
}

const post = <T>(path: string, body: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body) })

/** null when there is no server (the UI is served statically and talks to salt-api directly). */
export async function detectServer(): Promise<ServerInfo | null> {
  try {
    const res = await fetch('/api/config', { headers: { Accept: 'application/json' } })
    if (!res.ok || !res.headers.get('content-type')?.includes('application/json')) return null
    const body = (await res.json()) as Partial<ServerInfo>
    return body.mode === 'server' ? (body as ServerInfo) : null
  } catch {
    return null
  }
}

export const setupAdmin = (username: string, password: string, name?: string) => post<{ ok: true }>('/api/setup', { username, password, name })

export async function currentUser(): Promise<Me | null> {
  try {
    return await request<Me>('/api/me')
  } catch (e) {
    if (e instanceof SaltError && e.status === 401) return null
    throw e
  }
}

export function sessionFromMe(me: Me): Session {
  return {
    token: '', // the session lives in an httpOnly cookie
    expire: me.expiresAt ? Date.parse(me.expiresAt) / 1000 : Date.now() / 1000 + 3600,
    user: me.user.username || me.user.name,
    eauth: me.user.role,
    perms: me.perms,
  }
}

export class ServerTransport implements Transport {
  async login(username: string, password: string): Promise<Session> {
    await post('/api/auth/sign-in/username', { username, password })
    const me = await currentUser()
    if (!me) throw new SaltError('Signed in, but the session was not accepted')
    return sessionFromMe(me)
  }

  async logout() {
    await post('/api/auth/sign-out', {}).catch(() => undefined)
  }

  async call(low: Lowstate): Promise<unknown> {
    const res = await post<{ return: unknown }>('/api/salt', low)
    return res.return
  }

  events(_token: string, onEvent: (e: SaltEvent) => void, onStatus: (connected: boolean) => void) {
    return streamEvents('/api/salt/events', { credentials: 'same-origin' }, onEvent, onStatus)
  }
}

// ---- admin ----

export interface UserRow {
  id: string
  name: string
  username?: string | null
  role?: string | null
  banned?: boolean | null
  createdAt: string
}

export const users = {
  list: () => request<{ users: UserRow[]; total: number }>('/api/auth/admin/list-users?limit=500&sortBy=createdAt&sortDirection=asc'),
  create: (u: { username: string; name: string; password: string; role: Role }) =>
    post('/api/auth/admin/create-user', { email: `${u.username.toLowerCase()}@users.salt-shaker.invalid`, password: u.password, name: u.name || u.username, role: u.role, data: { username: u.username } }),
  setRole: (userId: string, role: Role) => post('/api/auth/admin/set-role', { userId, role }),
  setPassword: (userId: string, newPassword: string) => post('/api/auth/admin/set-user-password', { userId, newPassword }),
  ban: (userId: string) => post('/api/auth/admin/ban-user', { userId }),
  unban: (userId: string) => post('/api/auth/admin/unban-user', { userId }),
  remove: (userId: string) => post('/api/auth/admin/remove-user', { userId }),
}

export const changeOwnPassword = (currentPassword: string, newPassword: string) =>
  post('/api/auth/change-password', { currentPassword, newPassword, revokeOtherSessions: true })

export interface AuditRow {
  id: number
  at: string
  username: string
  role: string | null
  client: string
  fun: string
  target: string | null
  targetType: string | null
  args: string | null
  jid: string | null
  outcome: 'ok' | 'denied' | 'error'
  error: string | null
  ip: string | null
}

export const auditLog = (opts: { q?: string; before?: number; limit?: number } = {}) => {
  const p = new URLSearchParams()
  if (opts.q) p.set('q', opts.q)
  if (opts.before) p.set('before', String(opts.before))
  p.set('limit', String(opts.limit ?? 100))
  return request<{ rows: AuditRow[] }>(`/api/audit?${p}`)
}

// ---- history (recorded by the server from the event bus) ----

export interface HistoryJob {
  jid: string
  fun: string
  args: string | null
  target: string | null
  targetType: string | null
  saltUser: string | null
  shakerUser: string | null
  minions: string | null
  dryRun: boolean
  startedAt: string
  returned: number
  failed: number
}

export interface HistoryReturn {
  jid: string
  minion: string
  ret: unknown
  retcode: number | null
  success: boolean | null
  returnedAt: string
}

export interface ComplianceRun {
  jid: string
  target: string | null
  targetType: string | null
  startedAt: string
  by: string | null
  counts: { ok: number; drift: number; error: number; noreturn: number }
}

export const history = {
  jobs: (opts: { q?: string; before?: number; limit?: number } = {}) => {
    const p = new URLSearchParams()
    if (opts.q) p.set('q', opts.q)
    if (opts.before) p.set('before', String(opts.before))
    p.set('limit', String(opts.limit ?? 100))
    return request<{ rows: HistoryJob[]; retentionDays: number }>(`/api/history/jobs?${p}`)
  },
  job: (jid: string) => request<{ job: HistoryJob; returns: HistoryReturn[] }>(`/api/history/jobs/${encodeURIComponent(jid)}`),
  compliance: (limit = 30) => request<{ runs: ComplianceRun[] }>(`/api/history/compliance?limit=${limit}`),
}

/** Job arguments as stored by the master: positional args plus a trailing {__kwarg__: true, ...}. */
export const parseStoredArgs = (args: string | null): unknown[] => {
  try {
    const v = args ? JSON.parse(args) : []
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}
