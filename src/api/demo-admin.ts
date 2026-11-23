import { recordDemoAudit } from './demo-audit'
import type { Invite, Role, SystemStatus, UserRow, UserScope, invites, scopes, system, users } from './server'

/*
 * The demo's users and the System page: a made-up team with each role (kept in the browser) and
 * the server status a healthy install would show. Nothing here signs anyone in.
 */

const DAY = 86400_000
const at = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString()

const team: UserRow[] = [
  { id: 'u1', name: 'Pam Admin', email: 'pam@users.salt-shaker.invalid', username: 'pam', role: 'admin', banned: false, createdAt: at(120), lastSignInAt: at(0) },
  { id: 'u2', name: 'Olga Operator', email: 'olga@users.salt-shaker.invalid', username: 'olga', role: 'operator', banned: false, createdAt: at(90), lastSignInAt: at(1) },
  { id: 'u3', name: 'Otto Oncall', email: 'otto@example.com', username: 'otto', role: 'operator', banned: false, createdAt: at(60), lastSignInAt: at(3) },
  { id: 'u4', name: 'Vic Viewer', email: 'vic@users.salt-shaker.invalid', username: 'vic', role: 'viewer', banned: false, createdAt: at(30), lastSignInAt: at(0.3) },
  { id: 'u5', name: 'Nina New', email: 'nina@example.com', username: 'nina', role: 'none', banned: false, createdAt: at(2), lastSignInAt: null },
]

const delay = <T>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 120))
const find = (id: string) => team.find((u) => u.id === id)
const change = (id: string, fun: string, apply: (u: UserRow) => void, args?: object) => {
  const u = find(id)
  if (!u) return Promise.reject(new Error('User not found'))
  apply(u)
  recordDemoAudit({ username: 'demo', client: 'admin', fun, target: u.username ?? u.name, args: args ? JSON.stringify(args) : null, outcome: 'ok' })
  return delay({})
}

// Otto is on call for the web tier only
const limits = new Map<string, UserScope & { updatedBy: string; updatedAt: string }>([['u3', { target: 'web-*', targetType: 'glob', updatedBy: 'pam', updatedAt: at(20) }]])

export const demoScopes: typeof scopes = {
  list: () => delay({ scopes: [...limits].map(([userId, s]) => ({ userId, ...s })) }),
  set: (id: string, s: UserScope) =>
    change(id, 'user.set_scope', () => limits.set(id, { ...s, updatedBy: 'demo', updatedAt: new Date().toISOString() }), s),
  clear: (id: string) => change(id, 'user.clear_scope', () => limits.delete(id)),
}

export const demoUsers: typeof users = {
  list: () => delay({ users: team.map((u) => ({ ...u })), total: team.length }),
  setRole: (id: string, role: Role) => change(id, 'user.set_role', (u) => (u.role = role), { role }),
  setPassword: (id: string) => change(id, 'user.set_password', () => undefined),
  ban: (id: string) => change(id, 'user.ban', (u) => (u.banned = true)),
  unban: (id: string) => change(id, 'user.unban', (u) => (u.banned = false)),
  remove: (id: string) =>
    change(id, 'user.remove', (u) => {
      team.splice(team.indexOf(u), 1)
    }),
}

// one invitation waiting to be accepted; the demo's links lead nowhere, there is no server to accept them
const pending: Invite[] = [
  { id: 1, username: 'ivan', name: 'Ivan Intern', role: 'operator', scopeTarget: 'db-*', scopeTargetType: 'glob', createdBy: 'pam', createdAt: at(2), expiresAt: at(-5), expired: false },
]
const demoToken = () => `inv_demo${Math.random().toString(36).slice(2, 12)}`
const until = (days: number) => new Date(Date.now() + days * DAY).toISOString()

export const demoInvites: typeof invites = {
  list: () => delay({ invites: pending.map((i) => ({ ...i, expired: Date.parse(i.expiresAt) <= Date.now() })) }),
  create: (i) => {
    if (team.some((x) => x.username === i.username)) return Promise.reject(new Error('Username is already taken'))
    if (pending.some((x) => x.username === i.username)) return Promise.reject(new Error('This username is already invited: make a new link for it, or revoke it first'))
    const row: Invite = { id: Date.now(), username: i.username, name: i.name || null, role: i.role, scopeTarget: i.scope?.target ?? null, scopeTargetType: i.scope?.targetType ?? null, createdBy: 'demo', createdAt: new Date().toISOString(), expiresAt: until(i.days), expired: false }
    pending.push(row)
    recordDemoAudit({ username: 'demo', client: 'admin', fun: 'user.invite', target: i.username, args: JSON.stringify({ role: i.role, days: i.days, ...(i.scope ? { scope: i.scope } : {}) }), outcome: 'ok' })
    return delay({ ...row, token: demoToken() })
  },
  renew: (id, days) => {
    const row = pending.find((x) => x.id === id)
    if (!row) return Promise.reject(new Error('Not found'))
    row.expiresAt = until(days)
    recordDemoAudit({ username: 'demo', client: 'admin', fun: 'user.renew_invite', target: row.username, args: JSON.stringify({ days }), outcome: 'ok' })
    return delay({ ...row, expired: false, token: demoToken() })
  },
  revoke: (id) => {
    const i = pending.findIndex((x) => x.id === id)
    if (i < 0) return Promise.reject(new Error('Not found'))
    const [row] = pending.splice(i, 1)
    recordDemoAudit({ username: 'demo', client: 'admin', fun: 'user.revoke_invite', target: row.username, outcome: 'ok' })
    return delay({ ok: true as const })
  },
}

const started = new Date(Date.now() - 6 * DAY - 3 * 3600_000).toISOString()

export const demoSystem: typeof system = () =>
  delay<SystemStatus>({
    version: __APP_VERSION__,
    instance: 'demo:1:a1b2c3',
    role: 'all',
    startedAt: started,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    saltApi: { url: 'https://salt-master.lab.internal:8000', username: 'salt-shaker', eauth: 'pam', ok: true, ms: 38, error: null, keys: { accepted: 6, pending: 2, rejected: 0, denied: 0 } },
    events: {
      leader: 'demo:1:a1b2c3',
      leaderStale: null,
      thisInstance: true,
      stream: { state: 'connected', since: started, lastEventAt: new Date(Date.now() - 4000).toISOString(), lastError: null },
    },
    database: { dialect: 'sqlite', jobs: 1284, oldestJob: at(90), retentionDays: 90, auditRetentionDays: 365 },
    notifications: { channels: 2, enabled: 1, failing: [] },
    schedules: { total: 4, enabled: 4 },
    settings: { publicUrl: 'https://salt.example.com', trustedOrigins: [], sso: { name: 'Keycloak', active: true }, passwordLogin: 'admins', presenceMinutes: 5, metrics: true, trustProxy: true },
  })
