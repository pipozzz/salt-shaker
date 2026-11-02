import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Config {
  port: number
  publicUrl: string
  dataDir: string
  databaseUrl: string
  dialect: 'sqlite' | 'pg'
  authSecret: string
  saltApi: { url: string; username: string; password: string; eauth: string }
  staticDir: string
  /** Extra origins allowed to call the API with cookies (e.g. the Vite dev server). */
  trustedOrigins: string[]
  /** How long job history is kept in the database. */
  historyDays: number
  /** Behind a reverse proxy: take the client IP from X-Forwarded-For instead of the socket. */
  trustProxy: boolean
  /** Who may sign in with a password; 'admins' keeps it as a break-glass when SSO is on. */
  passwordLogin: 'all' | 'admins'
  oidc: OidcConfig | null
  /** Bearer token for GET /metrics (Prometheus); the endpoint is off without one. */
  metricsToken: string | null
}

export interface OidcConfig {
  name: string
  discoveryUrl: string
  clientId: string
  clientSecret: string
  scopes: string[]
  /** claim holding groups/roles, e.g. "groups"; when set, the IdP decides roles on every sign-in */
  roleClaim: string | null
  groups: { admin: string[]; operator: string[]; viewer: string[] }
  defaultRole: 'admin' | 'operator' | 'viewer' | 'none'
}

const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean)

function loadOidc(): OidcConfig | null {
  const issuer = process.env.OIDC_ISSUER?.replace(/\/+$/, '')
  if (!issuer) return null
  const roleClaim = process.env.OIDC_ROLE_CLAIM?.trim() || null
  const defaultRole = (process.env.OIDC_DEFAULT_ROLE ?? (roleClaim ? 'none' : 'viewer')) as OidcConfig['defaultRole']
  if (!['admin', 'operator', 'viewer', 'none'].includes(defaultRole)) throw new Error('OIDC_DEFAULT_ROLE must be admin, operator, viewer or none')
  return {
    name: process.env.OIDC_NAME ?? 'SSO',
    discoveryUrl: process.env.OIDC_DISCOVERY_URL ?? `${issuer}/.well-known/openid-configuration`,
    clientId: required('OIDC_CLIENT_ID'),
    clientSecret: required('OIDC_CLIENT_SECRET'),
    scopes: list(process.env.OIDC_SCOPES ?? 'openid,profile,email'),
    roleClaim,
    groups: { admin: list(process.env.OIDC_ADMIN_GROUPS), operator: list(process.env.OIDC_OPERATOR_GROUPS), viewer: list(process.env.OIDC_VIEWER_GROUPS) },
    defaultRole,
  }
}

function required(name: string) {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is required`)
  return v
}

/** BETTER_AUTH_SECRET, or a random one persisted in the data dir on first start. */
function authSecret(dataDir: string) {
  if (process.env.BETTER_AUTH_SECRET) return process.env.BETTER_AUTH_SECRET
  const file = join(dataDir, 'auth-secret')
  if (existsSync(file)) return readFileSync(file, 'utf8').trim()
  const secret = randomBytes(32).toString('base64url')
  writeFileSync(file, secret, { mode: 0o600 })
  return secret
}

export function loadConfig(): Config {
  const dataDir = process.env.DATA_DIR ?? './data'
  mkdirSync(dataDir, { recursive: true })
  const databaseUrl = process.env.DATABASE_URL ?? `file:${join(dataDir, 'salt-shaker.db')}`
  const dialect = /^postgres(ql)?:\/\//.test(databaseUrl) ? 'pg' : 'sqlite'
  return {
    port: Number(process.env.PORT ?? 8080),
    publicUrl: (process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 8080}`).replace(/\/+$/, ''),
    dataDir,
    databaseUrl,
    dialect,
    authSecret: authSecret(dataDir),
    saltApi: {
      url: required('SALT_API_URL').replace(/\/+$/, ''),
      username: required('SALT_API_USERNAME'),
      password: required('SALT_API_PASSWORD'),
      eauth: process.env.SALT_API_EAUTH ?? 'pam',
    },
    staticDir: process.env.STATIC_DIR ?? './dist',
    trustProxy: /^(1|true|yes)$/i.test(process.env.TRUST_PROXY ?? ''),
    passwordLogin: process.env.PASSWORD_LOGIN === 'admins' ? 'admins' : 'all',
    oidc: loadOidc(),
    metricsToken: process.env.METRICS_TOKEN?.trim() || null,
    historyDays: Math.max(1, Number(process.env.JOB_RETENTION_DAYS ?? 90) || 90),
    trustedOrigins: (process.env.TRUSTED_ORIGINS ?? '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean),
  }
}
