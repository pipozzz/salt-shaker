import { createHash, randomBytes } from 'node:crypto'
import { asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Db, Schema } from './db'
import { isRole } from './roles'
import { isUsername, USERNAME_RULE } from '../src/lib/username'
import { TARGET_TYPES } from './routes/automation'
import type { AuditRow, Env } from './types'

/*
 * Invitations: instead of making up a password for someone, an admin picks their username, role
 * and (for operators) the minions they're limited to, and gets a link to pass on. Whoever opens it
 * sets their own password, once, before it expires. Only a hash of the link's token is stored, so
 * the link is shown when it's made and can't be read back: a lost one is replaced by a new one.
 */

export const INVITE_PREFIX = 'inv_'
export const INVITE_DAYS = [1, 7, 30]
const MIN_PASSWORD = 10
const MAX_PASSWORD = 128

const hash = (token: string) => createHash('sha256').update(token).digest('hex')
const newToken = () => `${INVITE_PREFIX}${randomBytes(32).toString('base64url')}`

export interface InviteDeps {
  db: Db
  schema: Schema
  audit: (row: AuditRow) => Promise<unknown>
  /** creates the account with its password and returns its id (Better Auth, in the real server) */
  createUser: (u: { username: string; name: string; password: string; role: string }) => Promise<string>
  /** false for roles that can't sign in with a password here (PASSWORD_LOGIN=admins with SSO) */
  passwordAllowed?: (role: string) => boolean
  now?: () => Date
}

export function inviteRoutes({ db, schema, audit, createUser, passwordAllowed = () => true, now = () => new Date() }: InviteDeps) {
  const r = new Hono<Env>()
  const t = schema.userInvite

  // only the admin paths: the link itself (/invite/:token) is opened by someone who isn't signed in
  for (const path of ['/invites', '/invites/*']) {
    r.use(path, async (c, next) => {
      const user = c.get('user')
      if (!user) return c.json({ error: 'Not signed in' }, 401)
      if (user.role !== 'admin') return c.json({ error: 'Admins only' }, 403)
      // like tokens: handing out access takes a signed-in session
      if (c.get('via') === 'token') return c.json({ error: 'Manage invitations from the web UI' }, 403)
      await next()
    })
  }
  const who = (c: { get: (k: 'user') => Env['Variables']['user'] }) => {
    const u = c.get('user')!
    return { userId: u.id, username: u.username ?? u.name, role: u.role ?? null }
  }
  const view = ({ tokenHash: _h, ...row }: Schema['userInvite']['$inferSelect']) => ({ ...row, expired: row.expiresAt <= now() })
  const expiry = (days: number) => new Date(+now() + days * 86400_000)
  const readDays = (v: unknown) => {
    const days = v == null ? 7 : Number(v)
    return Number.isInteger(days) && days >= 1 && days <= 30 ? days : null
  }

  r.get('/invites', async (c) => c.json({ invites: (await db.select().from(t).orderBy(asc(t.id))).map(view) }))

  r.post('/invites', async (c) => {
    const me = who(c)
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : ''
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : ''
    const role = typeof body.role === 'string' ? body.role : ''
    const days = readDays(body.days)
    if (!isUsername(username)) return c.json({ error: `Username: ${USERNAME_RULE}` }, 400)
    if (!isRole(role) || role === 'none') return c.json({ error: 'Pick a role: admin, operator or viewer' }, 400)
    if (!passwordAllowed(role)) return c.json({ error: 'Only admins sign in with a password here; everyone else comes in through single sign-on' }, 400)
    if (days === null) return c.json({ error: 'days must be a whole number from 1 to 30' }, 400)
    // a limit only means something for operators: admins run everywhere, viewers run nothing
    let scope: { target: string; targetType: string } | null = null
    if (body.scope != null) {
      const s = body.scope as Record<string, unknown>
      const target = typeof s.target === 'string' ? s.target.trim() : ''
      const targetType = typeof s.targetType === 'string' ? s.targetType : ''
      if (role !== 'operator') return c.json({ error: 'Only operators can be limited to a target' }, 400)
      if (!target || target.length > 2000) return c.json({ error: 'A target is required (max 2000 characters)' }, 400)
      if (!TARGET_TYPES.includes(targetType)) return c.json({ error: 'Unknown target type' }, 400)
      scope = { target, targetType }
    }
    const taken = await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.username, username)).limit(1)
    if (taken.length) return c.json({ error: 'Username is already taken' }, 409)
    const invited = await db.select({ id: t.id }).from(t).where(eq(t.username, username)).limit(1)
    if (invited.length) return c.json({ error: 'This username is already invited: make a new link for it, or revoke it first' }, 409)

    const token = newToken()
    const [row] = await db
      .insert(t)
      .values({ username, name: name || null, role, scopeTarget: scope?.target ?? null, scopeTargetType: scope?.targetType ?? null, tokenHash: hash(token), createdBy: me.username, createdAt: now(), expiresAt: expiry(days) })
      .returning()
    await audit({ ...me, client: 'admin', fun: 'user.invite', target: username, args: JSON.stringify({ role, days, ...(scope ? { scope } : {}) }), outcome: 'ok' })
    return c.json({ token, ...view(row) }, 201)
  })

  /** A new link for an invitation (the old one stops working), valid for `days` again. */
  r.post('/invites/:id/renew', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const days = readDays(body.days)
    if (days === null) return c.json({ error: 'days must be a whole number from 1 to 30' }, 400)
    const token = newToken()
    const [row] = await db.update(t).set({ tokenHash: hash(token), expiresAt: expiry(days) }).where(eq(t.id, Number(c.req.param('id')))).returning()
    if (!row) return c.json({ error: 'Not found' }, 404)
    await audit({ ...who(c), client: 'admin', fun: 'user.renew_invite', target: row.username, args: JSON.stringify({ days }), outcome: 'ok' })
    return c.json({ token, ...view(row) })
  })

  r.delete('/invites/:id', async (c) => {
    const gone = await db.delete(t).where(eq(t.id, Number(c.req.param('id')))).returning({ username: t.username })
    if (!gone.length) return c.json({ error: 'Not found' }, 404)
    await audit({ ...who(c), client: 'admin', fun: 'user.revoke_invite', target: gone[0].username, outcome: 'ok' })
    return c.json({ ok: true })
  })

  // the same answer for a wrong, used, revoked and expired link: it says nothing about which
  const GONE = { error: 'This invitation link is not valid any more. Ask an admin for a new one.' }
  const find = async (token: string) => {
    if (!token.startsWith(INVITE_PREFIX)) return null
    const [row] = await db.select().from(t).where(eq(t.tokenHash, hash(token))).limit(1)
    return row && row.expiresAt > now() ? row : null
  }

  /** What the link is for, shown to whoever opens it. */
  r.get('/invite/:token', async (c) => {
    const row = await find(c.req.param('token'))
    if (!row) return c.json(GONE, 404)
    return c.json({ username: row.username, name: row.name, role: row.role, expiresAt: row.expiresAt })
  })

  /** Accept: { password, name? } creates the account. The link works once. */
  r.post('/invite/:token', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const password = typeof body.password === 'string' ? body.password : ''
    const givenName = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : ''
    const found = await find(c.req.param('token'))
    if (!found) return c.json(GONE, 404)
    if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) return c.json({ error: `Password: ${MIN_PASSWORD} to ${MAX_PASSWORD} characters` }, 400)
    // claimed first, so two requests with the same link can't both make an account
    const [row] = await db.delete(t).where(eq(t.tokenHash, found.tokenHash)).returning()
    if (!row) return c.json(GONE, 404)
    const by = { username: row.username, role: row.role, client: 'invite', fun: 'user.accept_invite', target: row.username, args: JSON.stringify({ invitedBy: row.createdBy }) }
    try {
      const userId = await createUser({ username: row.username, name: givenName || row.name || row.username, password, role: row.role })
      if (row.scopeTarget && row.scopeTargetType) {
        const scope = { userId, target: row.scopeTarget, targetType: row.scopeTargetType, updatedBy: row.createdBy, updatedAt: now() }
        try {
          await db.insert(schema.userScope).values(scope).onConflictDoUpdate({ target: schema.userScope.userId, set: scope })
        } catch (e) {
          // never leave an operator who was meant to be limited with the whole fleet
          await db.delete(schema.account).where(eq(schema.account.userId, userId))
          await db.delete(schema.user).where(eq(schema.user.id, userId))
          throw e
        }
      }
      await audit({ ...by, userId, outcome: 'ok' })
      return c.json({ ok: true, username: row.username }, 201)
    } catch (e) {
      // the account wasn't made: the link stays usable
      await db.insert(t).values({ ...row, id: undefined }).onConflictDoNothing()
      const error = e instanceof Error ? e.message : String(e)
      await audit({ ...by, outcome: 'error', error })
      return c.json({ error: `The account could not be created: ${error}` }, 500)
    }
  })

  return r
}
