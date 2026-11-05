import { asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Db, Schema } from '../db'
import type { Env } from '../types'
import { TARGET_TYPES } from './automation'

/**
 * Named targets shared by the team. Everyone signed in reads them; operators and admins save
 * them; a target can be replaced or removed by whoever saved it, or by an admin.
 */
export function targetRoutes({ db, schema }: { db: Db; schema: Schema }) {
  const r = new Hono<Env>()
  const t = schema.savedTarget

  r.use('*', async (c, next) => {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Not signed in' }, 401)
    if (user.role === 'none') return c.json({ error: 'No role' }, 403)
    await next()
  })

  const who = (c: { get: (k: 'user') => Env['Variables']['user'] }) => {
    const u = c.get('user')!
    return { name: u.username ?? u.name, admin: u.role === 'admin', writer: u.role === 'admin' || u.role === 'operator' }
  }

  r.get('/targets', async (c) => c.json({ targets: await db.select().from(t).orderBy(asc(t.name)) }))

  r.post('/targets', async (c) => {
    const me = who(c)
    if (!me.writer) return c.json({ error: 'Only operators and admins can share targets' }, 403)
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const target = typeof body.target === 'string' ? body.target.trim() : ''
    const targetType = typeof body.targetType === 'string' ? body.targetType : ''
    if (!name || name.length > 80) return c.json({ error: 'Name is required (max 80 characters)' }, 400)
    if (!target || target.length > 2000) return c.json({ error: 'Target is required (max 2000 characters)' }, 400)
    if (!TARGET_TYPES.includes(targetType)) return c.json({ error: 'Unknown target type' }, 400)
    const [existing] = await db.select().from(t).where(eq(t.name, name)).limit(1)
    if (existing) {
      if (!me.admin && existing.createdBy !== me.name) return c.json({ error: `“${name}” was saved by ${existing.createdBy ?? 'someone else'}; pick another name` }, 409)
      const [row] = await db.update(t).set({ target, targetType }).where(eq(t.id, existing.id)).returning()
      return c.json({ target: row })
    }
    const [row] = await db.insert(t).values({ name, target, targetType, createdBy: me.name, createdAt: new Date() }).returning()
    return c.json({ target: row }, 201)
  })

  r.delete('/targets/:id', async (c) => {
    const me = who(c)
    const id = Number(c.req.param('id'))
    const [existing] = await db.select().from(t).where(eq(t.id, id)).limit(1)
    if (!existing) return c.json({ error: 'Not found' }, 404)
    if (!me.admin && existing.createdBy !== me.name) return c.json({ error: 'Only whoever saved it, or an admin, can remove it' }, 403)
    await db.delete(t).where(eq(t.id, id))
    return c.json({ ok: true })
  })

  return r
}
