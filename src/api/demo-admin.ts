import { recordDemoAudit } from './demo-audit'
import type { Role, SystemStatus, UserRow, system, users } from './server'

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

export const demoUsers: typeof users = {
  list: () => delay({ users: team.map((u) => ({ ...u })), total: team.length }),
  create: (u) => {
    if (team.some((x) => x.username === u.username)) return Promise.reject(new Error('Username is already taken'))
    team.push({ id: `u${team.length + 1}-${Date.now()}`, name: u.name || u.username, email: `${u.username}@users.salt-shaker.invalid`, username: u.username, role: u.role, banned: false, createdAt: new Date().toISOString(), lastSignInAt: null })
    // the password isn't kept anywhere in the demo
    recordDemoAudit({ username: 'demo', client: 'admin', fun: 'user.create', target: u.username, args: JSON.stringify({ role: u.role }), outcome: 'ok' })
    return delay({})
  },
  setRole: (id: string, role: Role) => change(id, 'user.set_role', (u) => (u.role = role), { role }),
  setPassword: (id: string) => change(id, 'user.set_password', () => undefined),
  ban: (id: string) => change(id, 'user.ban', (u) => (u.banned = true)),
  unban: (id: string) => change(id, 'user.unban', (u) => (u.banned = false)),
  remove: (id: string) =>
    change(id, 'user.remove', (u) => {
      team.splice(team.indexOf(u), 1)
    }),
}

const started = new Date(Date.now() - 6 * DAY - 3 * 3600_000).toISOString()

export const demoSystem: typeof system = () =>
  delay<SystemStatus>({
    version: __APP_VERSION__,
    instance: 'demo:1:a1b2c3',
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
