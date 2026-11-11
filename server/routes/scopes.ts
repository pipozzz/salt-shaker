import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Db, Schema } from '../db'
import type { AuditRow, Env } from '../types'
import { TARGET_TYPES } from './automation'

/** Admins limit users to the minions a target matches; see server/scope.ts for how it's enforced. */
export function scopeRoutes({ db, schema, audit }: { db: Db; schema: Schema; audit: (row: AuditRow) => Promise<unknown> }) {
  const r = new Hono<Env>()
  const t = schema.userScope

  for (const path of ['/scopes', '/scopes/*']) {
    r.use(path, async (c, next) => {
      const user = c.get('user')
      if (!user) return c.json({ error: 'Not signed in' }, 401)
      if (user.role !== 'admin') return c.json({ error: 'Admins only' }, 403)
      await next()
    })
  }
  const who = (c: { get: (k: 'user') => Env['Variables']['user'] }) => {
    const u = c.get('user')!
    return { userId: u.id, username: u.username ?? u.name, role: u.role }
  }
  const nameOf = async (userId: string) => {
    const [u] = await db.select({ username: schema.user.username, name: schema.user.name }).from(schema.user).where(eq(schema.user.id, userId)).limit(1)
    return u ? (u.username ?? u.name) : null
  }

  r.get('/scopes', async (c) => c.json({ scopes: await db.select().from(t) }))

  r.put('/scopes/:userId', async (c) => {
    const userId = c.req.param('userId')
    const target = await nameOf(userId)
    if (!target) return c.json({ error: 'No such user' }, 404)
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const tgt = typeof body.target === 'string' ? body.target.trim() : ''
    const tgtType = typeof body.targetType === 'string' ? body.targetType : ''
    if (!tgt || tgt.length > 2000) return c.json({ error: 'A target is required (max 2000 characters)' }, 400)
    if (!TARGET_TYPES.includes(tgtType)) return c.json({ error: 'Unknown target type' }, 400)
    const values = { userId, target: tgt, targetType: tgtType, updatedBy: who(c).username, updatedAt: new Date() }
    await db.insert(t).values(values).onConflictDoUpdate({ target: t.userId, set: { target: tgt, targetType: tgtType, updatedBy: values.updatedBy, updatedAt: values.updatedAt } })
    await audit({ ...who(c), client: 'admin', fun: 'user.set_scope', target, args: JSON.stringify({ target: tgt, targetType: tgtType }), outcome: 'ok' })
    return c.json({ scope: values })
  })

  r.delete('/scopes/:userId', async (c) => {
    const userId = c.req.param('userId')
    const gone = await db.delete(t).where(eq(t.userId, userId)).returning({ id: t.userId })
    if (!gone.length) return c.json({ error: 'Not limited' }, 404)
    await audit({ ...who(c), client: 'admin', fun: 'user.clear_scope', target: (await nameOf(userId)) ?? userId, outcome: 'ok' })
    return c.json({ ok: true })
  })

  return r
}
