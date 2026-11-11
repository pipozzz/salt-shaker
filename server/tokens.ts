import { createHash, randomBytes } from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Db, Schema } from './db'
import type { AuditRow, Env, SessionUser } from './types'

/*
 * Personal API tokens: a script or CI job sends `Authorization: Bearer ss_…` and acts as the user
 * who made the token, with their current role, limits, approvals and audit trail. Only a hash is
 * stored; the token is shown once. Tokens can't make tokens, and a disabled user's tokens stop.
 */

export const TOKEN_PREFIX = 'ss_'
const hash = (token: string) => createHash('sha256').update(token).digest('hex')
export const newToken = () => `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`

/** The user a bearer token belongs to, or null (unknown, expired, or its user can't sign in). */
export async function userForToken(db: Db, schema: Schema, token: string, now = new Date()): Promise<SessionUser | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null
  const t = schema.apiToken
  const [row] = await db.select().from(t).where(eq(t.tokenHash, hash(token))).limit(1)
  if (!row || (row.expiresAt && row.expiresAt <= now)) return null
  const u = schema.user
  const [user] = await db.select({ id: u.id, name: u.name, username: u.username, role: u.role, banned: u.banned }).from(u).where(eq(u.id, row.userId)).limit(1)
  if (!user || user.banned || !user.role || user.role === 'none') return null
  // a write per minute at most, not per request
  if (!row.lastUsedAt || +now - +row.lastUsedAt > 60_000) await db.update(t).set({ lastUsedAt: now }).where(eq(t.id, row.id))
  return { id: user.id, name: user.name, username: user.username, role: user.role }
}

export function tokenRoutes({ db, schema, audit }: { db: Db; schema: Schema; audit: (row: AuditRow) => Promise<unknown> }) {
  const r = new Hono<Env>()
  const t = schema.apiToken
  for (const path of ['/tokens', '/tokens/*']) {
    r.use(path, async (c, next) => {
      const user = c.get('user')
      if (!user) return c.json({ error: 'Not signed in' }, 401)
      if (user.role === 'none') return c.json({ error: 'No role' }, 403)
      // a token can't be used to make or see tokens: that takes a signed-in session
      if (c.get('via') === 'token') return c.json({ error: 'Manage tokens from the web UI' }, 403)
      await next()
    })
  }
  const who = (c: { get: (k: 'user') => Env['Variables']['user'] }) => {
    const u = c.get('user')!
    return { userId: u.id, username: u.username ?? u.name, role: u.role ?? null }
  }
  const view = ({ tokenHash: _h, ...row }: Schema['apiToken']['$inferSelect']) => row

  r.get('/tokens', async (c) => {
    const rows = await db.select().from(t).where(eq(t.userId, who(c).userId)).orderBy(desc(t.id))
    return c.json({ tokens: rows.map(view) })
  })

  r.post('/tokens', async (c) => {
    const me = who(c)
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const days = body.days == null ? null : Number(body.days)
    if (!name || name.length > 80) return c.json({ error: 'Name it (max 80 characters), e.g. after the job that uses it' }, 400)
    if (days !== null && !(Number.isInteger(days) && days >= 1 && days <= 3650)) return c.json({ error: 'days must be a whole number from 1 to 3650' }, 400)
    const token = newToken()
    const now = new Date()
    const [row] = await db
      .insert(t)
      .values({ userId: me.userId, name, tokenHash: hash(token), prefix: token.slice(0, 10), createdAt: now, expiresAt: days ? new Date(+now + days * 86400_000) : null })
      .returning()
    await audit({ ...me, client: 'console', fun: 'token.create', target: name, args: JSON.stringify({ days }), outcome: 'ok' })
    return c.json({ token, ...view(row) }, 201)
  })

  r.delete('/tokens/:id', async (c) => {
    const me = who(c)
    const gone = await db.delete(t).where(and(eq(t.id, Number(c.req.param('id'))), eq(t.userId, me.userId))).returning({ name: t.name })
    if (!gone.length) return c.json({ error: 'Not found' }, 404)
    await audit({ ...me, client: 'console', fun: 'token.delete', target: gone[0].name, outcome: 'ok' })
    return c.json({ ok: true })
  })

  return r
}
