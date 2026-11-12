import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import type { RunbookParam } from '../src/lib/runbook'
import { readCallValues, readHookSettings } from '../src/lib/runbook-hook'
import type { Db, Schema } from './db'
import { startRun, type RouteDeps } from './runbooks'
import type { Env, SessionUser } from './types'

/*
 * Webhooks that start a runbook, for tools that can't sign in: monitoring, CI, a ticket system.
 * Each one runs one runbook, as itself with an operator's rights (so APPROVAL_REQUIRED=risky
 * applies to it), with values the admin set and only the ones they let a call set.
 *
 * A call proves it knows the webhook's secret one of two ways:
 *   - signed like Salt Shaker's own webhooks: X-Salt-Shaker-Timestamp and X-Salt-Shaker-Signature
 *     (sha256= HMAC of "<timestamp>.<raw body>"), at most five minutes old;
 *   - or, for tools that only send a header, Authorization: Bearer <secret>.
 */

type HookRow = Schema['runbookHook']['$inferSelect']

/** How old a signed call may be, either way, before it counts as replayed. */
export const SIGNATURE_WINDOW_S = 5 * 60
/** Calls carry a few values, not documents. */
export const MAX_BODY = 64 * 1024

export const newHookSecret = () => `whk_${randomBytes(24).toString('base64url')}`

const same = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Whether a call knows the secret: a fresh signature over its body, or the secret as a bearer token. */
export function verifyCall(secret: string, h: { authorization?: string; timestamp?: string; signature?: string }, body: string, nowMs = Date.now()) {
  if (h.signature) {
    if (!h.timestamp || !/^\d{1,12}$/.test(h.timestamp)) return false
    if (Math.abs(nowMs / 1000 - Number(h.timestamp)) > SIGNATURE_WINDOW_S) return false
    return same(h.signature, `sha256=${createHmac('sha256', secret).update(`${h.timestamp}.${body}`).digest('hex')}`)
  }
  const bearer = /^Bearer (\S+)$/.exec(h.authorization ?? '')?.[1]
  return !!bearer && same(bearer, secret)
}

export { readCallValues }

export const hookStarter = (id: number) => `hook:${id}`

/** Who a webhook's run acts as: the webhook, with an operator's rights, while it's there and on. */
export async function hookUser(db: Db, schema: Schema, id: string): Promise<SessionUser | null> {
  const n = Number(id.slice('hook:'.length))
  if (!Number.isInteger(n)) return null
  const t = schema.runbookHook
  const [row] = await db.select({ name: t.name, enabled: t.enabled }).from(t).where(eq(t.id, n))
  return row?.enabled ? { id, name: `hook:${row.name}`, username: `hook:${row.name}`, role: 'operator' } : null
}

const view = (h: HookRow) => {
  const { secret: _secret, ...rest } = h
  return { ...rest, params: JSON.parse(h.params) as Record<string, string>, fromRequest: JSON.parse(h.fromRequest) as string[] }
}

class BadRequest extends Error {}

/** The webhook endpoint (no sign-in) and its admin routes. */
export function hookRoutes(d: RouteDeps & { now?: () => number }) {
  const r = new Hono<Env>()
  const t = d.schema.runbookHook
  const runs = d.schema.runbookRun
  const now = d.now ?? Date.now
  r.onError((e, c) => (e instanceof BadRequest ? c.json({ error: e.message }, 400) : c.json({ error: 'Internal error' }, 500)))

  /** Starts the webhook's run with the values it sets and the call's; one at a time. */
  const fire = async (hook: HookRow, given: Record<string, string>) => {
    const fail = async (status: 400 | 404 | 409, error: string, run?: number) => {
      await d.db.update(t).set({ lastCalledAt: new Date(now()), lastError: error }).where(eq(t.id, hook.id))
      return { status, body: { error, ...(run ? { run } : {}) } }
    }
    const [rb] = await d.db.select().from(d.schema.runbook).where(eq(d.schema.runbook.id, hook.runbookId))
    if (!rb) return fail(404, 'Its runbook no longer exists')
    const starter = hookStarter(hook.id)
    const [live] = await d.db.select({ id: runs.id }).from(runs).where(and(eq(runs.startedById, starter), inArray(runs.status, ['pending', 'running'])))
    if (live) return fail(409, `Its last run, #${live.id}, hasn't finished`, live.id)
    const values = { ...(JSON.parse(hook.params) as Record<string, string>), ...given }
    const started = await startRun(d, rb, values, { userId: starter, username: `hook:${hook.name}`, role: 'operator' })
    if ('error' in started) return fail(400, started.error)
    await d.db.update(t).set({ lastCalledAt: new Date(now()), lastRunId: started.run.id, lastError: null }).where(eq(t.id, hook.id))
    return { status: 202 as const, body: { run: started.run.id, status: started.run.status, path: `/runbooks/runs/${started.run.id}` } }
  }

  // ---- the endpoint other tools call ----

  r.post('/hooks/runbooks/:id', async (c) => {
    const length = Number(c.req.header('content-length') ?? 0)
    if (length > MAX_BODY) return c.json({ error: 'The body is too large' }, 413)
    const body = await c.req.text()
    if (body.length > MAX_BODY) return c.json({ error: 'The body is too large' }, 413)
    const [hook] = await d.db.select().from(t).where(eq(t.id, Number(c.req.param('id')) || 0))
    // the same answer whether there's no such webhook or the secret is wrong
    const ok = hook && verifyCall(hook.secret, { authorization: c.req.header('authorization'), timestamp: c.req.header('x-salt-shaker-timestamp'), signature: c.req.header('x-salt-shaker-signature') }, body, now())
    if (!hook || !ok) return c.json({ error: 'Unknown webhook, or a wrong secret or signature' }, 401)
    if (!hook.enabled) return c.json({ error: 'This webhook is turned off' }, 403)
    const read = readCallValues(body, JSON.parse(hook.fromRequest) as string[])
    if ('error' in read) return c.json({ error: read.error }, 400)
    const res = await fire(hook, read.values)
    return c.json(res.body, res.status)
  })

  // ---- managing them: admins ----

  for (const p of ['/runbook-hooks', '/runbook-hooks/*']) {
    r.use(p, async (c, next) => {
      const user = c.get('user')
      if (!user) return c.json({ error: 'Not signed in' }, 401)
      if (user.role !== 'admin') return c.json({ error: 'Admins only' }, 403)
      await next()
    })
  }
  const who = (c: Context<Env>) => {
    const u = c.get('user')!
    return { userId: u.id, username: u.username ?? u.name, role: u.role ?? null }
  }

  /** Name, runbook, the values it sets and the ones a call may set: every required value is covered. */
  const readHook = async (body: Record<string, unknown>) => {
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name || name.length > 80) throw new BadRequest('Name is required (max 80 characters)')
    const runbookId = Number(body.runbookId)
    const [rb] = Number.isInteger(runbookId) ? await d.db.select().from(d.schema.runbook).where(eq(d.schema.runbook.id, runbookId)) : []
    if (!rb) throw new BadRequest('Choose a runbook')
    const settings = readHookSettings(JSON.parse(rb.params) as RunbookParam[], body.params, body.fromRequest)
    if ('error' in settings) throw new BadRequest(settings.error)
    return { name, runbookId, params: JSON.stringify(settings.params), fromRequest: JSON.stringify(settings.fromRequest) }
  }

  const sameName = async (name: string, id: number | null) => {
    const [row] = await d.db.select({ id: t.id }).from(t).where(eq(t.name, name))
    if (row && row.id !== id) throw new BadRequest('A webhook with this name already exists')
  }

  r.get('/runbook-hooks', async (c) => c.json({ hooks: (await d.db.select().from(t).orderBy(asc(t.name))).map(view) }))

  r.post('/runbook-hooks', async (c) => {
    const values = await readHook((await c.req.json().catch(() => ({}))) as Record<string, unknown>)
    await sameName(values.name, null)
    const secret = newHookSecret()
    const [row] = await d.db.insert(t).values({ ...values, secret, enabled: true, createdBy: who(c).username, createdAt: new Date(now()) }).returning()
    await d.audit({ ...who(c), client: 'admin', fun: 'runbook_hook.create', target: values.name, args: JSON.stringify({ runbookId: values.runbookId, params: JSON.parse(values.params), fromRequest: JSON.parse(values.fromRequest) }), outcome: 'ok' })
    // the secret is shown this once
    return c.json({ hook: view(row), secret }, 201)
  })

  const find = async (c: Context<Env>) => {
    const [row] = await d.db.select().from(t).where(eq(t.id, Number(c.req.param('id'))))
    return row
  }

  r.patch('/runbook-hooks/:id', async (c) => {
    const current = await find(c)
    if (!current) return c.json({ error: 'Not found' }, 404)
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const onlyToggle = Object.keys(body).length === 1 && typeof body.enabled === 'boolean'
    const changes = onlyToggle ? { enabled: body.enabled as boolean } : { ...(await readHook({ ...view(current), ...body })), ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}) }
    if ('name' in changes) await sameName(changes.name, current.id)
    const [row] = await d.db.update(t).set(changes).where(eq(t.id, current.id)).returning()
    await d.audit({ ...who(c), client: 'admin', fun: 'runbook_hook.update', target: current.name, args: JSON.stringify(changes), outcome: 'ok' })
    return c.json({ hook: view(row) })
  })

  r.delete('/runbook-hooks/:id', async (c) => {
    const current = await find(c)
    if (!current) return c.json({ error: 'Not found' }, 404)
    await d.db.delete(t).where(eq(t.id, current.id))
    await d.audit({ ...who(c), client: 'admin', fun: 'runbook_hook.delete', target: current.name, outcome: 'ok' })
    return c.json({ ok: true })
  })

  /** A new secret; the old one stops working right away. */
  r.post('/runbook-hooks/:id/secret', async (c) => {
    const current = await find(c)
    if (!current) return c.json({ error: 'Not found' }, 404)
    const secret = newHookSecret()
    await d.db.update(t).set({ secret }).where(eq(t.id, current.id))
    await d.audit({ ...who(c), client: 'admin', fun: 'runbook_hook.rotate_secret', target: current.name, outcome: 'ok' })
    return c.json({ secret })
  })

  /** A call from the page, with a body as a tool would send it: it starts a real run. */
  r.post('/runbook-hooks/:id/test', async (c) => {
    const current = await find(c)
    if (!current) return c.json({ error: 'Not found' }, 404)
    if (!current.enabled) return c.json({ error: 'This webhook is turned off' }, 403)
    const body = await c.req.text()
    if (body.length > MAX_BODY) return c.json({ error: 'The body is too large' }, 413)
    const read = readCallValues(body, JSON.parse(current.fromRequest) as string[])
    if ('error' in read) return c.json({ error: read.error }, 400)
    await d.audit({ ...who(c), client: 'admin', fun: 'runbook_hook.test', target: current.name, outcome: 'ok' })
    const res = await fire(current, read.values)
    return c.json(res.body, res.status)
  })

  return r
}
