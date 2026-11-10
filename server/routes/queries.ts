import { asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { checkQuery } from '../../src/lib/osquery'
import type { Db, Schema } from '../db'
import type { Env } from '../types'

/**
 * osquery queries saved for the team. Everyone signed in reads them; operators and admins save
 * them; a query can be replaced or removed by whoever saved it, or by an admin.
 */
export function queryRoutes({ db, schema }: { db: Db; schema: Schema }) {
  const r = new Hono<Env>()
  const t = schema.savedQuery

  // only these paths: a '*' here would apply to every /api route mounted after this one
  for (const path of ['/queries', '/queries/*']) {
    r.use(path, async (c, next) => {
      const user = c.get('user')
      if (!user) return c.json({ error: 'Not signed in' }, 401)
      if (user.role === 'none') return c.json({ error: 'No role' }, 403)
      await next()
    })
  }

  const who = (c: { get: (k: 'user') => Env['Variables']['user'] }) => {
    const u = c.get('user')!
    return { name: u.username ?? u.name, admin: u.role === 'admin', writer: u.role === 'admin' || u.role === 'operator' }
  }

  r.get('/queries', async (c) => c.json({ queries: await db.select().from(t).orderBy(asc(t.name)) }))

  r.post('/queries', async (c) => {
    const me = who(c)
    if (!me.writer) return c.json({ error: 'Only operators and admins can save queries' }, 403)
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const sql = typeof body.sql === 'string' ? body.sql.trim() : ''
    if (!name || name.length > 80) return c.json({ error: 'Name is required (max 80 characters)' }, 400)
    if (sql.length > 10_000) return c.json({ error: 'The query is too long (max 10,000 characters)' }, 400)
    const invalid = checkQuery(sql)
    if (invalid) return c.json({ error: invalid }, 400)
    const [existing] = await db.select().from(t).where(eq(t.name, name)).limit(1)
    if (existing) {
      if (!me.admin && existing.createdBy !== me.name) return c.json({ error: `“${name}” was saved by ${existing.createdBy ?? 'someone else'}; pick another name` }, 409)
      const [row] = await db.update(t).set({ sql }).where(eq(t.id, existing.id)).returning()
      return c.json({ query: row })
    }
    const [row] = await db.insert(t).values({ name, sql, createdBy: me.name, createdAt: new Date() }).returning()
    return c.json({ query: row }, 201)
  })

  r.delete('/queries/:id', async (c) => {
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
