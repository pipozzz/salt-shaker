import { asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Db, Schema } from '../db'
import { CHANNEL_KINDS, EVENTS, isEvent, newWebhookSecret, type Notifier } from '../notify'
import { readRecipients } from '../mail'
import { recentScheduleRuns } from '../schedule-runs'
import { nextRun, runsAt, SCHEDULE_KINDS, type ScheduleKind, type Scheduler } from '../scheduler'
import { loadWindows } from '../windows'
import { checkQuery } from '../../src/lib/osquery'
import type { AuditRow, Env } from '../types'

export const TARGET_TYPES = ['glob', 'list', 'grain', 'compound', 'pcre', 'pillar', 'nodegroup']

class BadRequest extends Error {}

function str(v: unknown, field: string, { max = 500, optional = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (optional) return null
    throw new BadRequest(`${field} is required`)
  }
  if (typeof v !== 'string' || v.length > max) throw new BadRequest(`${field} must be text (max ${max} characters)`)
  return v.trim()
}

function validateCron(cron: string) {
  try {
    if (!nextRun(cron)) throw new Error('never runs')
  } catch (e) {
    throw new BadRequest(`Invalid schedule "${cron}": ${e instanceof Error ? e.message : e}`)
  }
}

function validateUrl(url: string) {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new BadRequest('Webhook URL is not a valid URL')
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new BadRequest('Webhook URL must use http or https')
}

/** Where a channel sends: a webhook URL, or for email a clean list of recipients. */
function readDestination(kind: string, raw: string) {
  if (kind !== 'email') {
    validateUrl(raw)
    return raw
  }
  const r = readRecipients(raw)
  if ('error' in r) throw new BadRequest(r.error)
  return r.to.join(', ')
}

/** Webhook URLs embed secrets; show only enough to recognize them. */
export function maskUrl(url: string) {
  try {
    const u = new URL(url)
    const tail = (u.pathname + u.search).slice(-4)
    return `${u.protocol}//${u.host}/…${tail}`
  } catch {
    return '…'
  }
}

/** Schedules and notification channels; admin only. */
export function automationRoutes(deps: { db: Db; schema: Schema; scheduler: Scheduler; notifier: Notifier; audit: (row: AuditRow) => Promise<unknown> }) {
  const { db, schema, scheduler, notifier, audit } = deps
  const r = new Hono<Env>()

  r.use('*', async (c, next) => {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Not signed in' }, 401)
    if (user.role !== 'admin') return c.json({ error: 'Admins only' }, 403)
    await next()
  })

  r.onError((e, c) => (e instanceof BadRequest ? c.json({ error: e.message }, 400) : c.json({ error: 'Internal error' }, 500)))

  const who = (c: { get: (k: 'user') => Env['Variables']['user'] }) => {
    const u = c.get('user')!
    return { userId: u.id, username: u.username ?? u.name, role: u.role }
  }

  r.get('/automation/meta', (c) =>
    c.json({ kinds: SCHEDULE_KINDS, events: EVENTS, channelKinds: CHANNEL_KINDS, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, email: !!notifier.mail }),
  )

  // ---- schedules ----

  const t = schema.schedule

  const readSchedule = (body: Record<string, unknown>) => {
    const kind = str(body.kind, 'Kind', { max: 20 }) as ScheduleKind
    if (!(kind in SCHEDULE_KINDS)) throw new BadRequest('Unknown kind')
    const targetType = str(body.targetType, 'Target type', { max: 20 })!
    if (!TARGET_TYPES.includes(targetType)) throw new BadRequest('Unknown target type')
    const cron = str(body.cron, 'Schedule', { max: 100 })!
    validateCron(cron)
    const fun = kind === 'function' ? str(body.fun, 'Function', { max: 100 }) : null
    if (fun && !/^[A-Za-z_][\w.]*$/.test(fun)) throw new BadRequest('Invalid function name')
    let args = kind === 'function' && body.args && typeof body.args === 'object' ? JSON.stringify(body.args) : null
    if (kind === 'osquery') {
      const sql = str((body.args as { sql?: unknown } | null)?.sql, 'Query', { max: 10_000 })!
      const invalid = checkQuery(sql)
      if (invalid) throw new BadRequest(invalid)
      args = JSON.stringify({ sql })
    }
    const windowId = body.windowId === null || body.windowId === undefined || body.windowId === '' ? null : Number(body.windowId)
    if (windowId !== null && !Number.isInteger(windowId)) throw new BadRequest('Unknown maintenance window')
    return { name: str(body.name, 'Name', { max: 80 })!, kind, fun, args, target: str(body.target, 'Target')!, targetType, cron, windowId }
  }

  const checkWindow = async (windowId: number | null) => {
    if (windowId === null) return
    const [w] = await db.select({ id: schema.maintenanceWindow.id }).from(schema.maintenanceWindow).where(eq(schema.maintenanceWindow.id, windowId))
    if (!w) throw new BadRequest('Unknown maintenance window')
  }

  r.get('/schedules', async (c) => {
    const rows = await db.select().from(t).orderBy(asc(t.name))
    const runs = await recentScheduleRuns(db, schema, rows)
    const windows = new Map((await loadWindows(db, schema)).map((w) => [w.id, w]))
    return c.json({
      schedules: rows.map((s) => {
        let next: Date | null = null
        let cronError: string | null = null
        try {
          next = s.enabled ? runsAt(s, s.windowId ? windows.get(s.windowId) : undefined) : null
        } catch (e) {
          cronError = e instanceof Error ? e.message : String(e)
        }
        return { ...s, args: s.args ? JSON.parse(s.args) : null, lastSummary: s.lastSummary ? JSON.parse(s.lastSummary) : null, nextRunAt: next, cronError, recentRuns: runs.get(s.name) ?? [] }
      }),
    })
  })

  r.post('/schedules', async (c) => {
    const values = readSchedule(await c.req.json())
    await checkWindow(values.windowId)
    const exists = await db.select({ id: t.id }).from(t).where(eq(t.name, values.name))
    if (exists.length) throw new BadRequest('A schedule with this name already exists')
    const [row] = await db
      .insert(t)
      .values({ ...values, enabled: true, createdBy: who(c).username, createdAt: new Date() })
      .returning()
    await audit({ ...who(c), client: 'admin', fun: 'schedule.create', target: values.name, args: JSON.stringify(values), outcome: 'ok' })
    return c.json({ schedule: row })
  })

  r.patch('/schedules/:id', async (c) => {
    const id = Number(c.req.param('id'))
    const body = (await c.req.json()) as Record<string, unknown>
    const [current] = await db.select().from(t).where(eq(t.id, id))
    if (!current) return c.json({ error: 'Not found' }, 404)
    const changes =
      Object.keys(body).length === 1 && typeof body.enabled === 'boolean'
        ? { enabled: body.enabled }
        : { ...readSchedule({ ...current, args: current.args ? JSON.parse(current.args) : null, ...body }), ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}) }
    if ('windowId' in changes) await checkWindow(changes.windowId)
    await db.update(t).set(changes).where(eq(t.id, id))
    await audit({ ...who(c), client: 'admin', fun: 'schedule.update', target: current.name, args: JSON.stringify(changes), outcome: 'ok' })
    return c.json({ ok: true })
  })

  r.delete('/schedules/:id', async (c) => {
    const id = Number(c.req.param('id'))
    const [current] = await db.select().from(t).where(eq(t.id, id))
    if (!current) return c.json({ error: 'Not found' }, 404)
    await db.delete(t).where(eq(t.id, id))
    await audit({ ...who(c), client: 'admin', fun: 'schedule.delete', target: current.name, outcome: 'ok' })
    return c.json({ ok: true })
  })

  r.post('/schedules/:id/run', async (c) => {
    const [s] = await db.select().from(t).where(eq(t.id, Number(c.req.param('id'))))
    if (!s) return c.json({ error: 'Not found' }, 404)
    const jid = await scheduler.run(s)
    return jid ? c.json({ jid }) : c.json({ error: 'The run could not start; see the schedule for details' }, 502)
  })

  // ---- notification channels ----

  const n = schema.notificationChannel

  const readEvents = (v: unknown) => {
    if (!Array.isArray(v) || !v.every(isEvent)) throw new BadRequest('Choose events from the list')
    return JSON.stringify([...new Set(v)])
  }

  r.get('/notifications', async (c) => {
    const rows = await db.select().from(n).orderBy(asc(n.name))
    // the secret is shown once, when it's made; the list only says whether there is one
    // recipients aren't secret, webhook URLs are
    return c.json({ channels: rows.map(({ url, secret, ...ch }) => ({ ...ch, url: ch.kind === 'email' ? url : maskUrl(url), events: JSON.parse(ch.events), signed: !!secret })) })
  })

  r.post('/notifications', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>
    const kind = str(body.kind, 'Kind', { max: 20 })!
    if (!(CHANNEL_KINDS as readonly string[]).includes(kind)) throw new BadRequest('Unknown channel kind')
    const url = readDestination(kind, str(body.url, kind === 'email' ? 'Recipients' : 'Webhook URL', { max: 2000 })!)
    const secret = kind === 'webhook' ? newWebhookSecret() : null
    const values = { name: str(body.name, 'Name', { max: 80 })!, kind, url, events: readEvents(body.events), enabled: true, secret, createdAt: new Date() }
    const [row] = await db.insert(n).values(values).returning({ id: n.id })
    await audit({ ...who(c), client: 'admin', fun: 'notification.create', target: values.name, args: JSON.stringify({ kind, events: body.events }), outcome: 'ok' })
    return c.json({ id: row.id, ...(secret ? { secret } : {}) })
  })

  r.patch('/notifications/:id', async (c) => {
    const id = Number(c.req.param('id'))
    const body = (await c.req.json()) as Record<string, unknown>
    const [current] = await db.select().from(n).where(eq(n.id, id))
    if (!current) return c.json({ error: 'Not found' }, 404)
    const changes: Partial<typeof current> = {}
    if (body.name !== undefined) changes.name = str(body.name, 'Name', { max: 80 })!
    if (body.events !== undefined) changes.events = readEvents(body.events)
    if (typeof body.enabled === 'boolean') changes.enabled = body.enabled
    // the URL is only replaced when a new one is sent; the masked one never comes back
    if (typeof body.url === 'string' && body.url.trim()) changes.url = readDestination(current.kind, body.url.trim())
    await db.update(n).set(changes).where(eq(n.id, id))
    await audit({ ...who(c), client: 'admin', fun: 'notification.update', target: current.name, args: JSON.stringify({ ...changes, url: changes.url ? (current.kind === 'email' ? changes.url : maskUrl(changes.url)) : undefined }), outcome: 'ok' })
    return c.json({ ok: true })
  })

  r.delete('/notifications/:id', async (c) => {
    const id = Number(c.req.param('id'))
    const [current] = await db.select().from(n).where(eq(n.id, id))
    if (!current) return c.json({ error: 'Not found' }, 404)
    await db.delete(n).where(eq(n.id, id))
    await audit({ ...who(c), client: 'admin', fun: 'notification.delete', target: current.name, outcome: 'ok' })
    return c.json({ ok: true })
  })

  /** A new signing secret for a JSON webhook; the old one stops working right away. */
  r.post('/notifications/:id/secret', async (c) => {
    const id = Number(c.req.param('id'))
    const [current] = await db.select().from(n).where(eq(n.id, id))
    if (!current) return c.json({ error: 'Not found' }, 404)
    if (current.kind !== 'webhook') throw new BadRequest('Only JSON webhooks are signed')
    const secret = newWebhookSecret()
    await db.update(n).set({ secret }).where(eq(n.id, id))
    await audit({ ...who(c), client: 'admin', fun: 'notification.rotate_secret', target: current.name, outcome: 'ok' })
    return c.json({ secret })
  })

  r.post('/notifications/:id/test', async (c) => {
    const [ch] = await db.select().from(n).where(eq(n.id, Number(c.req.param('id'))))
    if (!ch) return c.json({ error: 'Not found' }, 404)
    const error = await notifier.send(ch.id, ch.kind, ch.url, 'schedule', {
      title: 'Test notification from Salt Shaker',
      lines: [`Sent by ${who(c).username} to check the "${ch.name}" channel.`],
      severity: 'info',
      path: '/notifications',
    }, ch.secret)
    return error ? c.json({ error }, 502) : c.json({ ok: true })
  })

  return r
}
