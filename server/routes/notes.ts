import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Db, Schema } from '../db'
import type { AuditRow, Env } from '../types'

/** The longest note kept on a minion. */
export const MAX_NOTE = 2000

/**
 * Notes the team keeps on minions: who owns one, what it's for, what not to do to it. Everyone
 * signed in reads them; operators and admins write them, and every change is in the audit log.
 * An empty note removes it.
 */
export function noteRoutes({ db, schema, audit }: { db: Db; schema: Schema; audit: (row: AuditRow) => Promise<unknown> }) {
  const r = new Hono<Env>()
  const t = schema.minionNote

  for (const path of ['/minion-notes', '/minion-notes/*']) {
    r.use(path, async (c, next) => {
      const user = c.get('user')
      if (!user) return c.json({ error: 'Not signed in' }, 401)
      if (!user.role || user.role === 'none') return c.json({ error: 'No role' }, 403)
      await next()
    })
  }

  r.get('/minion-notes', async (c) => {
    const rows = await db.select().from(t)
    return c.json({ notes: Object.fromEntries(rows.map((n) => [n.minion, { note: n.note, updatedBy: n.updatedBy, updatedAt: n.updatedAt.toISOString() }])) })
  })

  r.put('/minion-notes/:minion', async (c) => {
    const u = c.get('user')!
    if (u.role !== 'admin' && u.role !== 'operator') return c.json({ error: 'Only operators and admins write notes' }, 403)
    const minion = c.req.param('minion')
    // eslint-disable-next-line no-control-regex
    if (!minion || minion.length > 255 || /[\u0000-\u001f\s]/.test(minion)) return c.json({ error: 'Not a minion id' }, 400)
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    if (typeof body.note !== 'string') return c.json({ error: 'The note is text' }, 400)
    const note = body.note.trim()
    if (note.length > MAX_NOTE) return c.json({ error: `A note is at most ${MAX_NOTE} characters` }, 400)
    const by = u.username ?? u.name
    const [before] = await db.select().from(t).where(eq(t.minion, minion))
    if ((before?.note ?? '') === note) return c.json({ note: before ? { note: before.note, updatedBy: before.updatedBy, updatedAt: before.updatedAt.toISOString() } : null })
    const now = new Date()
    if (!note) await db.delete(t).where(eq(t.minion, minion))
    else if (before) await db.update(t).set({ note, updatedBy: by, updatedAt: now }).where(eq(t.minion, minion))
    else await db.insert(t).values({ minion, note, updatedBy: by, updatedAt: now })
    await audit({ userId: u.id, username: by, role: u.role ?? null, client: 'console', fun: note ? 'minions.note' : 'minions.note_removed', target: minion, targetType: 'list', args: note ? JSON.stringify({ note }) : null, outcome: 'ok' })
    return c.json({ note: note ? { note, updatedBy: by, updatedAt: now.toISOString() } : null })
  })

  return r
}
