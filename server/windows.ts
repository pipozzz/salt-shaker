import { asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { readWindow, windowState, type MaintenanceWindow } from '../src/lib/windows'
import type { Db, Schema } from './db'
import type { AuditRow, Env } from './types'

type WindowRow = Schema['maintenanceWindow']['$inferSelect']

export const toWindow = (r: WindowRow): MaintenanceWindow => ({ id: r.id, name: r.name, days: JSON.parse(r.days) as number[], start: r.start, minutes: r.minutes, timezone: r.timezone })

export async function loadWindows(db: Db, schema: Schema) {
  const t = schema.maintenanceWindow
  return (await db.select().from(t).orderBy(asc(t.name))).map(toWindow)
}

/**
 * Maintenance windows: everyone signed in reads them (Run and Changes say when you're outside
 * them), admins add and remove them. Removing one frees the schedules that waited for it.
 */
export function windowRoutes(d: { db: Db; schema: Schema; audit: (row: AuditRow) => Promise<unknown>; now?: () => number }) {
  const r = new Hono<Env>()
  const t = d.schema.maintenanceWindow
  const now = d.now ?? Date.now

  const signedIn = async (c: { get: (k: 'user') => Env['Variables']['user']; json: (b: unknown, s: 401) => Response }, next: () => Promise<void>) => {
    if (!c.get('user')) return c.json({ error: 'Not signed in' }, 401)
    await next()
  }
  r.use('/windows', signedIn)
  r.use('/windows/*', signedIn)

  r.get('/windows', async (c) => {
    const windows = await loadWindows(d.db, d.schema)
    const state = windowState(windows, now())
    return c.json({
      windows,
      open: state.open && { id: state.open.window.id, end: state.open.end },
      next: state.next && { id: state.next.window.id, start: state.next.start, end: state.next.end },
    })
  })

  r.post('/windows', async (c) => {
    const user = c.get('user')!
    if (user.role !== 'admin') return c.json({ error: 'Admins only' }, 403)
    const w = readWindow((await c.req.json().catch(() => ({}))) as Record<string, unknown>)
    if ('error' in w) return c.json({ error: w.error }, 400)
    if ((await d.db.select({ id: t.id }).from(t).where(eq(t.name, w.name))).length) return c.json({ error: 'A window with this name already exists' }, 400)
    const [row] = await d.db
      .insert(t)
      .values({ ...w, days: JSON.stringify(w.days), createdBy: user.username ?? user.name, createdAt: new Date(now()) })
      .returning()
    await d.audit({ userId: user.id, username: user.username ?? user.name, role: user.role ?? null, client: 'admin', fun: 'window.add', target: w.name, args: JSON.stringify(w), outcome: 'ok' })
    return c.json({ window: toWindow(row) })
  })

  r.delete('/windows/:id', async (c) => {
    const user = c.get('user')!
    if (user.role !== 'admin') return c.json({ error: 'Admins only' }, 403)
    const id = Number(c.req.param('id'))
    const [row] = await d.db.select().from(t).where(eq(t.id, id))
    if (!row) return c.json({ error: 'Not found' }, 404)
    await d.db.update(d.schema.schedule).set({ windowId: null }).where(eq(d.schema.schedule.windowId, id))
    await d.db.delete(t).where(eq(t.id, id))
    await d.audit({ userId: user.id, username: user.username ?? user.name, role: user.role ?? null, client: 'admin', fun: 'window.remove', target: row.name, outcome: 'ok' })
    return c.json({ ok: true })
  })

  return r
}
