import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { and, count, desc, eq, like, lt, or, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { secureHeaders } from 'hono/secure-headers'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createAuth, emailFor } from './auth'
import { loadConfig } from './config'
import { openDatabase } from './db'
import { authorize, jidOf } from './policy'
import { isRole, ROLE_PERMS } from './roles'
import { SaltService, UpstreamError } from './salt'

const config = loadConfig()
const { db, schema, provider } = await openDatabase(config)
const auth = createAuth(config, db, schema, provider)
const salt = new SaltService(config.saltApi)

type SessionUser = { id: string; name: string; username?: string | null; role?: string | null }
const app = new Hono<{ Variables: { user: SessionUser | null; expiresAt: Date | null } }>()

app.use(
  '*',
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      connectSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ['https://fonts.gstatic.com'],
      frameAncestors: ["'none'"],
    },
    referrerPolicy: 'same-origin',
    xFrameOptions: 'DENY',
  }),
)

app.get('/healthz', (c) => c.text('ok\n'))

// The API is cookie-authenticated, so refuse state-changing requests from other origins.
// Browsers always send Origin on POST; requests without one (curl, scripts) carry no cookies by accident.
const trustedOrigins = new Set([config.publicUrl, ...config.trustedOrigins])
app.use('/api/*', async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const origin = c.req.header('origin')
    if (origin && !trustedOrigins.has(origin)) return c.json({ error: 'Cross-origin request refused' }, 403)
  }
  await next()
})

app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))

app.use('/api/*', async (c, next) => {
  const s = await auth.api.getSession({ headers: c.req.raw.headers })
  c.set('user', (s?.user as SessionUser | undefined) ?? null)
  c.set('expiresAt', s?.session.expiresAt ? new Date(s.session.expiresAt) : null)
  await next()
})

const userCount = async () => (await db.select({ n: count() }).from(schema.user))[0]?.n ?? 0

app.get('/api/config', async (c) => c.json({ mode: 'server', setupRequired: (await userCount()) === 0 }))

// first run: create the initial admin while there are no users at all
let settingUp = false
app.post('/api/setup', async (c) => {
  if (settingUp || (await userCount()) > 0) return c.json({ error: 'Setup is already done' }, 409)
  settingUp = true
  try {
    const body = await c.req.json<{ username?: string; name?: string; password?: string }>()
    const username = body.username?.trim().toLowerCase() ?? ''
    if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) return c.json({ error: 'Username: 3–32 characters, letters, digits, . _ -' }, 400)
    if (!body.password || body.password.length < 10) return c.json({ error: 'Password must be at least 10 characters' }, 400)
    await auth.api.createUser({ body: { email: emailFor(username), password: body.password, name: body.name?.trim() || username, role: 'admin', data: { username } } })
    return c.json({ ok: true })
  } finally {
    settingUp = false
  }
})

app.get('/api/me', (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Not signed in' }, 401)
  const role = isRole(user.role) ? user.role : 'viewer'
  return c.json({ user: { id: user.id, name: user.name, username: user.username, role }, perms: ROLE_PERMS[role], expiresAt: c.get('expiresAt') })
})

const audit = (row: Omit<typeof schema.auditLog.$inferInsert, 'at'>) => db.insert(schema.auditLog).values({ ...row, at: new Date() })

app.post('/api/salt', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Not signed in' }, 401)
  const username = user.username ?? user.name
  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null
  const decision = authorize(user.role, username, await c.req.json().catch(() => null))
  if (!decision.ok) {
    if (decision.status === 403 && decision.fun) {
      await audit({ userId: user.id, username, role: user.role, client: decision.client ?? '?', fun: decision.fun, outcome: 'denied', error: decision.reason, ip })
    }
    return c.json({ error: decision.reason }, decision.status)
  }
  const { low, audited } = decision
  const base = {
    userId: user.id,
    username,
    role: user.role,
    client: String(low.client),
    fun: String(low.fun),
    target: typeof low.tgt === 'string' ? low.tgt : null,
    targetType: typeof low.tgt_type === 'string' ? low.tgt_type : null,
    args: JSON.stringify({ arg: low.arg ?? [], kwarg: low.kwarg ?? {}, ...Object.fromEntries(Object.entries(low).filter(([k]) => !['client', 'fun', 'tgt', 'tgt_type', 'arg', 'kwarg', 'metadata'].includes(k))) }),
    ip,
  }
  try {
    const ret = await salt.call(low)
    if (audited) await audit({ ...base, jid: jidOf(ret), outcome: 'ok' })
    return c.json({ return: ret })
  } catch (e) {
    const err = e instanceof UpstreamError ? e : new UpstreamError(String(e), 502)
    if (audited) await audit({ ...base, outcome: 'error', error: err.message })
    return c.json({ error: err.message }, err.status as 400)
  }
})

app.get('/api/salt/events', async (c) => {
  if (!c.get('user')) return c.json({ error: 'Not signed in' }, 401)
  try {
    const body = await salt.events(c.req.raw.signal)
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' } })
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'events failed' }, 502)
  }
})

app.get('/api/audit', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Not signed in' }, 401)
  if (user.role !== 'admin' && user.role !== 'operator') return c.json({ error: 'Admins and operators only' }, 403)
  const limit = Math.min(Number(c.req.query('limit') ?? 100) || 100, 500)
  const before = Number(c.req.query('before')) || null
  const q = c.req.query('q')?.trim()
  const t = schema.auditLog
  const where = and(
    before ? lt(t.id, before) : undefined,
    // lower() on both sides: LIKE is case-insensitive in SQLite but not in Postgres
    q ? or(...[t.username, t.fun, t.target].map((col) => like(sql`lower(${col})`, `%${q.toLowerCase()}%`)), eq(t.jid, q)) : undefined,
  )
  const rows = await db.select().from(t).where(where).orderBy(desc(t.id)).limit(limit)
  return c.json({ rows })
})

app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404))

// the built SPA; unknown paths fall back to index.html for client-side routing
const indexHtml = join(config.staticDir, 'index.html')
app.use('/assets/*', serveStatic({ root: config.staticDir, onFound: (_p, c) => c.header('Cache-Control', 'public, max-age=31536000, immutable') }))
app.use('*', serveStatic({ root: config.staticDir }))
app.get('*', (c) => {
  if (!existsSync(indexHtml)) return c.text('UI not built: run npm run build', 404)
  c.header('Cache-Control', 'no-cache')
  return c.html(readFileSync(indexHtml, 'utf8'))
})

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`salt-shaker listening on :${info.port} (${provider}, salt-api ${config.saltApi.url})`)
})
