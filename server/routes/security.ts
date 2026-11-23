import { count, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Db, Schema } from '../db'
import type { AuditRow, Env } from '../types'

/**
 * What admins see and can do about how users sign in: who has a second step or passkeys, and
 * taking them away from someone who lost their phone or key (they sign in with the password alone
 * again, and set them up anew). Setting them up is each user's own business, through Better Auth.
 */
export function securityRoutes({ db, schema, audit }: { db: Db; schema: Schema; audit: (row: AuditRow) => Promise<unknown> }) {
  const r = new Hono<Env>()

  for (const path of ['/users/security', '/users/:id/reset-sign-in']) {
    r.use(path, async (c, next) => {
      const user = c.get('user')
      if (!user) return c.json({ error: 'Not signed in' }, 401)
      if (user.role !== 'admin') return c.json({ error: 'Admins only' }, 403)
      await next()
    })
  }

  /** Per user id: { twoFactor, passkeys }, only for users who have either. */
  r.get('/users/security', async (c) => {
    const out: Record<string, { twoFactor: boolean; passkeys: number }> = {}
    for (const u of await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.twoFactorEnabled, true))) out[u.id] = { twoFactor: true, passkeys: 0 }
    for (const p of await db.select({ userId: schema.passkey.userId, n: count() }).from(schema.passkey).groupBy(schema.passkey.userId)) (out[p.userId] ??= { twoFactor: false, passkeys: 0 }).passkeys = Number(p.n)
    return c.json({ users: out })
  })

  /** Removes a user's second step and passkeys, and signs them out everywhere. */
  r.post('/users/:id/reset-sign-in', async (c) => {
    const me = c.get('user')!
    const id = c.req.param('id')
    const [target] = await db.select({ username: schema.user.username, name: schema.user.name }).from(schema.user).where(eq(schema.user.id, id)).limit(1)
    if (!target) return c.json({ error: 'No such user' }, 404)
    const codes = await db.delete(schema.twoFactor).where(eq(schema.twoFactor.userId, id)).returning({ id: schema.twoFactor.id })
    const keys = await db.delete(schema.passkey).where(eq(schema.passkey.userId, id)).returning({ id: schema.passkey.id })
    await db.update(schema.user).set({ twoFactorEnabled: false }).where(eq(schema.user.id, id))
    // whoever holds the lost device may hold a session too
    await db.delete(schema.session).where(eq(schema.session.userId, id))
    await audit({ userId: me.id, username: me.username ?? me.name, role: me.role, client: 'admin', fun: 'user.reset_sign_in', target: target.username ?? target.name, args: JSON.stringify({ twoFactor: codes.length > 0, passkeys: keys.length }), outcome: 'ok' })
    return c.json({ ok: true, twoFactor: codes.length > 0, passkeys: keys.length })
  })

  return r
}
