import { streamEvents } from './sse'
import { SaltError, type Grains, type Lowstate, type SaltEvent, type Session, type Transport } from './types'

/** Talks to the Salt Shaker server (server/), which holds users and proxies salt-api. */

export interface ServerInfo {
  mode: 'server'
  setupRequired: boolean
  sso: { name: string; providerId: string; rolesFromIdp: boolean } | null
  passwordLogin: 'all' | 'admins'
}

export type Role = 'admin' | 'operator' | 'viewer' | 'none'
export const ROLES: Role[] = ['admin', 'operator', 'viewer', 'none']

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

/** Starts the OIDC redirect; the server sends the browser back here with a session cookie. */
export async function startSso(providerId: string) {
  // Better Auth serves generic OIDC providers through its standard social sign-in endpoint
  const res = await post<{ url?: string }>('/api/auth/sign-in/social', { provider: providerId, callbackURL: '/', errorCallbackURL: '/?sso_error=1' })
  if (!res.url) throw new SaltError('The identity provider did not return a sign-in URL')
  window.location.assign(res.url)
}

/** Better Auth's generic "no session" error, which our session hook triggers for users without access. */
export const isNoAccessError = (e: unknown) => e instanceof SaltError && /session/i.test(e.message)

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

  async fleet(fresh: boolean) {
    const res = await request<{ minions: Record<string, Grains> }>(`/api/fleet${fresh ? '?fresh=1' : ''}`)
    return res.minions
  }

  events(_token: string, onEvent: (e: SaltEvent) => void, onStatus: (connected: boolean) => void) {
    return streamEvents('/api/salt/events', { credentials: 'same-origin' }, onEvent, onStatus)
  }
}

// ---- admin ----

export interface UserRow {
  id: string
  name: string
  email: string
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

export interface AuditFilter {
  q?: string
  outcome?: '' | AuditRow['outcome']
  from?: string
  to?: string
}

const auditParams = (f: AuditFilter) => {
  const p = new URLSearchParams()
  for (const k of ['q', 'outcome', 'from', 'to'] as const) if (f[k]) p.set(k, f[k])
  return p
}

export const auditLog = (opts: AuditFilter & { before?: number; limit?: number } = {}) => {
  const p = auditParams(opts)
  if (opts.before) p.set('before', String(opts.before))
  p.set('limit', String(opts.limit ?? 100))
  return request<{ rows: AuditRow[] }>(`/api/audit?${p}`)
}

/** Where the browser downloads every entry matching a filter as CSV. */
export const auditExportUrl = (f: AuditFilter) => `/api/audit/export?${auditParams(f)}`

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

/** A recorded job seen from one minion: the job plus that minion's return, if it came. */
export interface MinionJob {
  jid: string
  fun: string
  args: string | null
  target: string | null
  targetType: string | null
  saltUser: string | null
  shakerUser: string | null
  dryRun: boolean
  startedAt: string
  returnedAt: string | null
  retcode: number | null
  success: boolean | null
  summary: string | null
}

/** How a job ended on one minion. Dry runs with pending changes count as drift. */
export function minionOutcome(j: Pick<MinionJob, 'returnedAt' | 'retcode' | 'success' | 'summary' | 'dryRun'>): 'noreturn' | 'failed' | 'drift' | 'changed' | 'ok' {
  if (!j.returnedAt) return 'noreturn'
  let sum: { changed?: number; pending?: number; failed?: number } = {}
  try {
    sum = j.summary ? JSON.parse(j.summary) : {}
  } catch {
    // treat as no summary
  }
  if ((j.retcode ?? 0) !== 0 || j.success === false || (sum.failed ?? 0) > 0) return 'failed'
  if ((sum.pending ?? 0) > 0) return 'drift'
  if ((sum.changed ?? 0) > 0) return 'changed'
  return 'ok'
}

export interface MinionCompliance {
  status: 'ok' | 'drift' | 'error'
  jid: string
  checkedAt: string
}

export interface MinionUpdates {
  packages: number
  jid: string
  checkedAt: string
}

export const history = {
  jobs: (opts: { q?: string; before?: number; limit?: number } = {}) => {
    const p = new URLSearchParams()
    if (opts.q) p.set('q', opts.q)
    if (opts.before) p.set('before', String(opts.before))
    p.set('limit', String(opts.limit ?? 100))
    return request<{ rows: HistoryJob[]; retentionDays: number }>(`/api/history/jobs?${p}`)
  },
  minionJobs: (id: string, opts: { before?: number; limit?: number } = {}) => {
    const p = new URLSearchParams()
    if (opts.before) p.set('before', String(opts.before))
    p.set('limit', String(opts.limit ?? 50))
    return request<{ rows: MinionJob[]; retentionDays: number }>(`/api/history/minions/${encodeURIComponent(id)}/jobs?${p}`)
  },
  /** Each minion's result in the latest compliance check it returned from. */
  minionCompliance: () => request<{ minions: Record<string, MinionCompliance> }>('/api/history/compliance/minions'),
  minionUpdates: () => request<{ minions: Record<string, MinionUpdates> }>('/api/history/updates/minions'),
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

// ---- automation (admin) ----

export type ScheduleKind = 'compliance' | 'patches' | 'function'
export type NotifyEvent = 'drift' | 'patches' | 'schedule' | 'job_failed' | 'pending_key' | 'minion_down'

export interface Schedule {
  id: number
  name: string
  kind: ScheduleKind
  fun: string | null
  args: { arg?: unknown[]; kwarg?: Record<string, unknown> } | null
  target: string
  targetType: string
  cron: string
  enabled: boolean
  createdBy: string | null
  lastRunAt: string | null
  lastJid: string | null
  lastSummary: Record<string, unknown> | null
  nextRunAt: string | null
  cronError: string | null
}

export interface ScheduleInput {
  name: string
  kind: ScheduleKind
  fun?: string | null
  args?: { arg: unknown[]; kwarg: Record<string, unknown> } | null
  target: string
  targetType: string
  cron: string
}

export interface Channel {
  id: number
  name: string
  kind: 'slack' | 'webhook'
  url: string
  events: NotifyEvent[]
  enabled: boolean
  lastSentAt: string | null
  lastError: string | null
}

export interface AutomationMeta {
  kinds: Record<ScheduleKind, string>
  events: Record<NotifyEvent, string>
  timezone: string
}

const send = <T>(method: string, path: string, body?: unknown) => request<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) })

export const automation = {
  meta: () => request<AutomationMeta>('/api/automation/meta'),
  schedules: () => request<{ schedules: Schedule[] }>('/api/schedules'),
  createSchedule: (s: ScheduleInput) => send('POST', '/api/schedules', s),
  updateSchedule: (id: number, s: Partial<ScheduleInput> & { enabled?: boolean }) => send('PATCH', `/api/schedules/${id}`, s),
  deleteSchedule: (id: number) => send('DELETE', `/api/schedules/${id}`),
  runSchedule: (id: number) => send<{ jid: string }>('POST', `/api/schedules/${id}/run`, {}),
  channels: () => request<{ channels: Channel[] }>('/api/notifications'),
  createChannel: (c: { name: string; kind: string; url: string; events: NotifyEvent[] }) => send('POST', '/api/notifications', c),
  updateChannel: (id: number, c: { name?: string; url?: string; events?: NotifyEvent[]; enabled?: boolean }) => send('PATCH', `/api/notifications/${id}`, c),
  deleteChannel: (id: number) => send('DELETE', `/api/notifications/${id}`),
  testChannel: (id: number) => send('POST', `/api/notifications/${id}/test`, {}),
}

/** GET /api/system (admins): whether this install works, without secrets. */
export interface SystemStatus {
  version: string
  instance: string
  startedAt: string
  timeZone: string
  saltApi: { url: string; username: string; eauth: string; ok: boolean; ms: number; error: string | null; keys: Record<'accepted' | 'pending' | 'rejected' | 'denied', number> | null }
  events: {
    /** the instance holding the events lease, if any */
    leader: string | null
    /** stale: the holder stopped renewing (crashed or killed); another instance takes over when the lease expires */
    leaderStale: { stale: boolean; renewedAt: string; expiresInSeconds: number } | null
    thisInstance: boolean
    stream: { state: 'stopped' | 'connecting' | 'connected'; since: string | null; lastEventAt: string | null; lastError: string | null } | null
  }
  database: { dialect: 'sqlite' | 'pg'; jobs: number; oldestJob: string | null; retentionDays: number }
  notifications: { channels: number; enabled: number; failing: Array<{ name: string; error: string }> }
  schedules: { total: number; enabled: number }
  settings: { publicUrl: string; trustedOrigins: string[]; sso: { name: string; active: boolean } | null; passwordLogin: 'all' | 'admins'; presenceMinutes: number; metrics: boolean; trustProxy: boolean }
}

export const system = () => request<SystemStatus>('/api/system')
