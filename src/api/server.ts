import { streamEvents } from './sse'
import { SaltError, type Grains, type Lowstate, type SaltEvent, type Session, type Transport } from './types'

/** Talks to the Salt Shaker server (server/), which holds users and proxies salt-api. */

export interface ServerInfo {
  mode: 'server'
  setupRequired: boolean
  sso: { name: string; providerId: string; rolesFromIdp: boolean } | null
  passwordLogin: 'all' | 'admins'
  /** risky: operators' commands that change minions need an admin's approval (APPROVAL_REQUIRED) */
  approval?: 'off' | 'risky'
}

export type Role = 'admin' | 'operator' | 'viewer' | 'none'
export const ROLES: Role[] = ['admin', 'operator', 'viewer', 'none']

export interface Me {
  user: { id: string; name: string; username: string; role: Role }
  perms: unknown[]
  scope?: UserScope | null
  expiresAt: string | null
}

/** The minions a user may run things on; none means the whole fleet. */
export interface UserScope {
  target: string
  targetType: string
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
    scope: me.scope ?? null,
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
  lastSignInAt?: string | null
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

/** CSV of every recorded job matching a search and result filter. */
export const jobsExportUrl = (f: { q?: string; result?: string }) => {
  const p = new URLSearchParams()
  if (f.q) p.set('q', f.q)
  if (f.result) p.set('result', f.result)
  return `/api/history/jobs/export?${p}`
}

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
  jobs: (opts: { q?: string; result?: string; before?: number; limit?: number } = {}) => {
    const p = new URLSearchParams()
    if (opts.q) p.set('q', opts.q)
    if (opts.result) p.set('result', opts.result)
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

export type ScheduleKind = 'compliance' | 'patches' | 'vulns' | 'osquery' | 'function'
export type NotifyEvent = 'drift' | 'patches' | 'vulns' | 'osquery' | 'acceptance' | 'approval' | 'change' | 'schedule' | 'job_failed' | 'pending_key' | 'minion_down'

export interface Schedule {
  id: number
  name: string
  kind: ScheduleKind
  fun: string | null
  args: { arg?: unknown[]; kwarg?: Record<string, unknown>; sql?: string } | null
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
  /** latest recorded runs, oldest first */
  recentRuns: ScheduleRun[]
}

export interface ScheduleRun {
  jid: string
  startedAt: string
  status: 'ok' | 'changed' | 'failed' | 'noreturn' | 'running'
  detail: string
}

export interface ScheduleInput {
  name: string
  kind: ScheduleKind
  fun?: string | null
  args?: { arg: unknown[]; kwarg: Record<string, unknown> } | { sql: string } | null
  target: string
  targetType: string
  cron: string
}

export interface Channel {
  id: number
  name: string
  kind: 'slack' | 'teams' | 'webhook'
  url: string
  events: NotifyEvent[]
  enabled: boolean
  lastSentAt: string | null
  lastError: string | null
  /** JSON webhooks: whether it has a signing secret (the secret itself is shown once) */
  signed?: boolean
}

export interface AutomationMeta {
  kinds: Record<ScheduleKind, string>
  events: Record<NotifyEvent, string>
  timezone: string
}

const send = <T>(method: string, path: string, body?: unknown) => request<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) })

export interface SharedTarget {
  id: number
  name: string
  target: string
  targetType: string
  createdBy: string | null
}

/** Named targets shared by the team (any signed-in user reads; operators and admins save). */
export const targets = {
  list: () => request<{ targets: SharedTarget[] }>('/api/targets'),
  save: (t: { name: string; target: string; targetType: string }) => send<{ target: SharedTarget }>('POST', '/api/targets', t),
  remove: (id: number) => send('DELETE', `/api/targets/${id}`),
}

export interface SavedQuery {
  id: number
  name: string
  sql: string
  createdBy: string | null
}

/** osquery queries saved for the team */
export const queries = {
  list: () => request<{ queries: SavedQuery[] }>('/api/queries'),
  save: (q: { name: string; sql: string }) => send<{ query: SavedQuery }>('POST', '/api/queries', q),
  remove: (id: number) => send('DELETE', `/api/queries/${id}`),
}

export const automation = {
  meta: () => request<AutomationMeta>('/api/automation/meta'),
  schedules: () => request<{ schedules: Schedule[] }>('/api/schedules'),
  createSchedule: (s: ScheduleInput) => send('POST', '/api/schedules', s),
  updateSchedule: (id: number, s: Partial<ScheduleInput> & { enabled?: boolean }) => send('PATCH', `/api/schedules/${id}`, s),
  deleteSchedule: (id: number) => send('DELETE', `/api/schedules/${id}`),
  runSchedule: (id: number) => send<{ jid: string }>('POST', `/api/schedules/${id}/run`, {}),
  channels: () => request<{ channels: Channel[] }>('/api/notifications'),
  createChannel: (c: { name: string; kind: string; url: string; events: NotifyEvent[] }) => send<{ id: number; secret?: string }>('POST', '/api/notifications', c),
  /** a new signing secret for a JSON webhook; the old one stops working */
  rotateSecret: (id: number) => send<{ secret: string }>('POST', `/api/notifications/${id}/secret`, {}),
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
  database: { dialect: 'sqlite' | 'pg'; jobs: number; oldestJob: string | null; retentionDays: number; auditRetentionDays: number }
  notifications: { channels: number; enabled: number; failing: Array<{ name: string; error: string }> }
  schedules: { total: number; enabled: number }
  settings: { publicUrl: string; trustedOrigins: string[]; sso: { name: string; active: boolean } | null; passwordLogin: 'all' | 'admins'; presenceMinutes: number; metrics: boolean; trustProxy: boolean }
}

export type ChangeStatus = 'pending' | 'rejected' | 'queued' | 'running' | 'done' | 'stopped' | 'failed'

/** One function on a target, run in batches, and approved first when the policy asks for it. */
export interface Change {
  id: number
  reason: string
  target: string
  targetType: string
  fun: string
  args: { arg: unknown[]; kwarg: Record<string, unknown> }
  batchSize: string | null
  maxFailures: number
  status: ChangeStatus
  requestedBy: string
  requestedById: string | null
  requestedAt: string
  decidedBy: string | null
  decidedAt: string | null
  decisionNote: string | null
  minions: string[] | null
  batches: Array<{ jid: string | null; minions: string[]; startedAt: string }>
  startedAt: string | null
  finishedAt: string | null
  error: string | null
}

export type MinionOutcome = 'ok' | 'failed' | 'running' | 'waiting'

export interface ChangeInput {
  reason: string
  target: string
  targetType: string
  fun: string
  arg: unknown[]
  kwarg: Record<string, unknown>
  batchSize: string
  maxFailures: number
}

export const changes = {
  list: () => request<{ changes: Change[]; approval: 'off' | 'risky' }>('/api/changes'),
  get: (id: number) => request<{ change: Change; outcome: Record<string, MinionOutcome> }>(`/api/changes/${id}`),
  create: (c: ChangeInput) => send<{ change: Change }>('POST', '/api/changes', c),
  approve: (id: number, note?: string) => send('POST', `/api/changes/${id}/approve`, { note }),
  reject: (id: number, note: string) => send('POST', `/api/changes/${id}/reject`, { note }),
  stop: (id: number) => send('POST', `/api/changes/${id}/stop`, {}),
}

/** An enrollment window: new minions matching the pattern are accepted without a click, for a while. */
export interface KeyRule {
  id: number
  pattern: string
  expiresAt: string
  maxAccepts: number
  accepted: string[]
  createdBy: string | null
  createdAt: string
}

export const keyRules = {
  list: () => request<{ rules: KeyRule[] }>('/api/key-rules'),
  open: (pattern: string, hours: number, maxAccepts: number) => send<{ rule: KeyRule }>('POST', '/api/key-rules', { pattern, hours, maxAccepts }),
  close: (id: number) => send('POST', `/api/key-rules/${id}/close`, {}),
}

/** A personal API token, without the token itself (shown once, when made). */
export interface ApiToken {
  id: number
  name: string
  prefix: string
  createdAt: string
  expiresAt: string | null
  lastUsedAt: string | null
}

export const tokens = {
  list: () => request<{ tokens: ApiToken[] }>('/api/tokens'),
  create: (name: string, days: number | null) => send<ApiToken & { token: string }>('POST', '/api/tokens', { name, days }),
  remove: (id: number) => send('DELETE', `/api/tokens/${id}`),
}

/** Admins limit users to the minions a target matches. */
export const scopes = {
  list: () => request<{ scopes: Array<UserScope & { userId: string; updatedBy: string | null; updatedAt: string }> }>('/api/scopes'),
  set: (userId: string, s: UserScope) => send('PUT', `/api/scopes/${encodeURIComponent(userId)}`, s),
  clear: (userId: string) => send('DELETE', `/api/scopes/${encodeURIComponent(userId)}`),
}

export const system = () => request<SystemStatus>('/api/system')

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'unknown'
export type SeverityCounts = Record<Severity, number> & { fixable: number }

/** How fresh the vulnerability report is, and whether the server is still building it. */
export interface VulnStatus {
  updating: boolean
  progress: { step: 'packages' | 'vulns'; done: number; total: number } | null
  builtAt: string | null
  /** OSV.dev couldn't be reached; the report comes from what was cached */
  error: string | null
  unchecked: number
}

export interface VulnMinion {
  minion: string
  jid: string
  scannedAt: string
  os: string | null
  ecosystem: string | null
  packages: number
  error: string | null
  counts: SeverityCounts
}

export interface Vuln {
  id: string
  cves: string[]
  severity: Severity
  score: number | null
  summary: string
}

export interface VulnSummary extends Vuln {
  packages: string[]
  minions: number
  /** minions where a fixed version exists */
  fixable: number
}

export interface VulnFinding extends Vuln {
  package: string
  version: string
  binaries: string[]
  fixed: string | null
}

export interface VulnAffected {
  minion: string
  package: string
  version: string
  binaries: string[]
  fixed: string | null
}

export interface VulnAcceptance {
  note: string
  acceptedBy: string | null
  acceptedAt: string
  expiresAt: string | null
}

/** One version of a package and the minions it's installed on. */
export interface InstalledPackage {
  name: string
  version: string
  ecosystem: string | null
  os: string | null
  binaries: string[]
  minions: string[]
}

/** Everything installed on one minion, from its latest inventory. */
export interface MinionPackages {
  updating: boolean
  minion: string
  os: string | null
  scannedAt: string
  packages: Array<{ name: string; version: string; binaries: string[]; vulns: number; fixable: number; worst: Severity | null }>
}

export interface PackageSearch {
  updating: boolean
  total: number
  minions: number
  packages: InstalledPackage[]
}

/** An accepted vulnerability; `vuln` is null when no minion has it any more. */
export interface VulnAccepted extends VulnAcceptance {
  id: string
  vuln: Vuln | null
  packages: string[]
  minions: number
}

/** The report's totals on one day (UTC): distinct vulnerabilities by severity, with a fix, and minions */
export type VulnDay = Record<Severity, number> & { day: string; fixable: number; minions: number; affected: number }

export const vulns = {
  // a short wait: while the server is still building, the page polls and shows the progress
  report: () => request<VulnStatus & { minions: VulnMinion[]; vulns: VulnSummary[]; accepted: VulnAccepted[] }>('/api/vulns?wait=3000'),
  /** per-minion counts only, without waiting for a report that's being built */
  minions: () => request<VulnStatus & { minions: VulnMinion[] }>('/api/vulns?only=minions&wait=0'),
  minion: (id: string) => request<VulnStatus & { minion: VulnMinion; findings: VulnFinding[] }>(`/api/vulns/minions/${encodeURIComponent(id)}`),
  /** CSV of every finding matching the page's filters */
  exportUrl: (f: { severity?: string; fix?: boolean; q?: string }) => {
    const p = new URLSearchParams()
    if (f.severity) p.set('severity', f.severity)
    if (f.fix) p.set('fix', '1')
    if (f.q) p.set('q', f.q)
    const qs = p.toString()
    return `/api/vulns/export${qs ? `?${qs}` : ''}`
  },
  byId: (id: string) => request<VulnStatus & { vuln: Vuln; minions: VulnAffected[]; acceptance: VulnAcceptance | null }>(`/api/vulns/by-id/${encodeURIComponent(id)}`),
  /** accept the risk of a vulnerability, for `days` or until withdrawn */
  accept: (id: string, note: string, days: number | null) => post<{ accepted: VulnAcceptance & { id: string } }>('/api/vulns/accepted', { id, note, days }),
  minionPackages: (id: string) => request<MinionPackages>(`/api/vulns/minions/${encodeURIComponent(id)}/packages`),
  /** where packages whose name contains `q` are installed */
  packages: (q: string) => request<PackageSearch>(`/api/vulns/packages?q=${encodeURIComponent(q)}`),
  trend: (days = 90) => request<{ days: VulnDay[] }>(`/api/vulns/trend?days=${days}`),
  unaccept: (id: string) => request<{ ok: true }>(`/api/vulns/accepted/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** per minion, the installed packages with a fixed version for a known vulnerability */
  fixes: (wait = 0) => request<VulnStatus & { minions: VulnFixes }>(`/api/vulns/fixes?wait=${wait}`),
}

/** minion -> installed (binary) package -> the vulnerabilities with a fixed version */
export type VulnFixes = Record<string, { ecosystem: string | null; packages: Record<string, Array<{ id: string; severity: Severity; fixed: string }>> }>
