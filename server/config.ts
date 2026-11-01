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
    trustedOrigins: (process.env.TRUSTED_ORIGINS ?? '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean),
  }
}
