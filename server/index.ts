import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { and, count, desc, eq, inArray, like, lt, or, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { secureHeaders } from 'hono/secure-headers'
import { timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from 'hono'
import { CLIENT_IP_HEADER, createAuth, emailFor } from './auth'
import { loadConfig } from './config'
import { openDatabase } from './db'
import { HistoryRecorder } from './history'
import { Leader } from './leader'
import { collectMetrics, formatMetrics } from './metrics'
import { Notifier } from './notify'
import { automationRoutes } from './routes/automation'
import { Scheduler } from './scheduler'
import { trimFleet } from '../src/lib/fleet'
import { authorize, jidOf } from './policy'
import { canFor, isRole, ROLE_PERMS } from './roles'
import pkg from '../package.json' with { type: 'json' }
import { SaltService, UpstreamError } from './salt'
import type { AuditRow, Env, SessionUser } from './types'

const config = loadConfig()
const { db, schema, provider } = await openDatabase(config)
let auth = createAuth(config, db, schema, provider)

// Better Auth reads the OIDC discovery document once, when it is created, and drops the provider if
// that fails. If the IdP isn't reachable at start-up, keep checking and rebuild auth once it is.
if (config.oidc) {
  const discoveryUrl = config.oidc.discoveryUrl
  const reachable = () =>
    fetch(discoveryUrl, { signal: AbortSignal.timeout(5000) })
      .then((r) => r.ok)
      .catch(() => false)
  if (!(await reachable())) {
    console.warn(`sso: ${discoveryUrl} is not reachable yet; SSO stays off until it is`)
    const retry = setInterval(async () => {
      if (!(await reachable())) return
      clearInterval(retry)
      auth = createAuth(config, db, schema, provider)
      console.log('sso: identity provider reachable, SSO enabled')
    }, 10_000)
  }
}
const salt = new SaltService(config.saltApi)
const history = new HistoryRecorder(db, schema, salt, config.historyDays)
const notifier = new Notifier(db, schema, config.publicUrl)
history.onEvent((tag, data) => notifier.onEvent(tag, data))
history.onReturn((r) => notifier.onReturn(r))
// with several instances on one database, only the lease holder follows the event bus, so jobs
// are recorded once and event alerts aren't duplicated
const eventsLeader = new Leader(db, schema, 'events', { onAcquire: () => history.start(), onLose: () => history.stop() })
eventsLeader.start()

const app = new Hono<Env>()

/** The caller's IP: the socket peer, or the first X-Forwarded-For hop when behind a trusted proxy. */
function clientIp(c: Context<Env>) {
  if (config.trustProxy) {
    const fwd = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    if (fwd) return fwd
  }
  return c.env.incoming?.socket?.remoteAddress ?? null
}

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

// Prometheus scrape endpoint, off unless METRICS_TOKEN is set (key and schedule names aren't public)
app.get('/metrics', async (c) => {
  if (!config.metricsToken) return c.text('Not found\n', 404)
  const given = Buffer.from(c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '')
  const want = Buffer.from(config.metricsToken)
  if (given.length !== want.length || !timingSafeEqual(given, want)) return c.text('Unauthorized\n', 401, { 'WWW-Authenticate': 'Bearer' })
  const gauges = await collectMetrics({ db, schema, salt, version: pkg.version, isLeader: eventsLeader.isLeader })
  return c.text(formatMetrics(gauges), 200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' })
})

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

app.on(['GET', 'POST'], '/api/auth/*', async (c) => {
  // hand Better Auth a trustworthy client IP for its rate limiter (overwriting anything the client sent)
  const headers = new Headers(c.req.raw.headers)
  headers.set(CLIENT_IP_HEADER, clientIp(c) ?? 'unknown')
  const res = await auth.handler(new Request(c.req.raw, { headers }))
  // our session hook refusing a user surfaces as a 500 from Better Auth; it's a 403
  if (res.status === 500 && res.headers.get('content-type')?.includes('json')) {
    const body = (await res.clone().json().catch(() => null)) as { code?: string } | null
    if (body?.code === 'FAILED_TO_CREATE_SESSION') return c.json({ error: 'This account cannot sign in here', code: body.code }, 403)
  }
  return res
})

app.use('/api/*', async (c, next) => {
  const s = await auth.api.getSession({ headers: c.req.raw.headers })
  c.set('user', (s?.user as SessionUser | undefined) ?? null)
  c.set('expiresAt', s?.session.expiresAt ? new Date(s.session.expiresAt) : null)
  await next()
})

const userCount = async () => (await db.select({ n: count() }).from(schema.user))[0]?.n ?? 0

app.get('/api/config', async (c) =>
  c.json({
    mode: 'server',
    version: pkg.version,
    setupRequired: (await userCount()) === 0,
    sso: config.oidc ? { name: config.oidc.name, providerId: 'oidc', rolesFromIdp: !!config.oidc.roleClaim } : null,
    passwordLogin: config.oidc ? config.passwordLogin : 'all',
  }),
)

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

const audit = (row: AuditRow) => db.insert(schema.auditLog).values({ ...row, at: new Date() })

app.post('/api/salt', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Not signed in' }, 401)
  const username = user.username ?? user.name
  const ip = clientIp(c)
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

// ---- fleet: grains from the master's minion data cache, trimmed and shared ----

// one short-lived copy for every user, so opening Minions doesn't hit the master each time
let fleetCache: { at: number; data: ReturnType<typeof trimFleet> } | null = null
let fleetLoading: Promise<ReturnType<typeof trimFleet>> | null = null
const FLEET_TTL_MS = 15_000

app.get('/api/fleet', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Not signed in' }, 401)
  if (!canFor(user.role)('runner', 'cache.grains')) return c.json({ error: 'Your role may not read grains' }, 403)
  const fresh = c.req.query('fresh') === '1'
  if (fresh || !fleetCache || Date.now() - fleetCache.at > FLEET_TTL_MS) {
    fleetLoading ??= salt
      .call({ client: 'runner', fun: 'cache.grains', tgt: '*', tgt_type: 'glob' })
      .then((all) => trimFleet(all as Record<string, unknown>))
      .finally(() => (fleetLoading = null))
    try {
      fleetCache = { at: Date.now(), data: await fleetLoading }
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : 'cache.grains failed' }, 502)
    }
  }
  return c.json({ minions: fleetCache.data, cachedAt: new Date(fleetCache.at).toISOString() })
})

// ---- job history (recorded from the event bus by HistoryRecorder) ----

app.get('/api/history/jobs', async (c) => {
  if (!c.get('user')) return c.json({ error: 'Not signed in' }, 401)
  const limit = Math.min(Number(c.req.query('limit') ?? 100) || 100, 500)
  const before = Number(c.req.query('before')) || null
  const q = c.req.query('q')?.trim().toLowerCase()
  const t = schema.job
  const r = schema.jobReturn
  const rows = await db
    .select({
      jid: t.jid,
      fun: t.fun,
      args: t.args,
      target: t.target,
      targetType: t.targetType,
      saltUser: t.saltUser,
      shakerUser: t.shakerUser,
      minions: t.minions,
      dryRun: t.dryRun,
      startedAt: t.startedAt,
      returned: count(r.minion),
      // no bound booleans (SQLite can't bind them); `not coalesce(x, true)` works in both dialects
      failed: sql<number>`coalesce(sum(case when ${r.retcode} <> 0 or not coalesce(${r.success}, true) then 1 else 0 end), 0)`.mapWith(Number),
    })
    .from(t)
    .leftJoin(r, eq(r.jid, t.jid))
    .where(
      and(
        before ? lt(t.startedAt, new Date(before)) : undefined,
        q ? or(...[t.fun, t.target, t.shakerUser, t.saltUser].map((col) => like(sql`lower(${col})`, `%${q}%`)), eq(t.jid, q)) : undefined,
      ),
    )
    .groupBy(t.jid)
    .orderBy(desc(t.startedAt))
    .limit(limit)
  return c.json({ rows, retentionDays: config.historyDays })
})

app.get('/api/history/jobs/:jid', async (c) => {
  if (!c.get('user')) return c.json({ error: 'Not signed in' }, 401)
  const jid = c.req.param('jid')
  const [jobRow] = await db.select().from(schema.job).where(eq(schema.job.jid, jid)).limit(1)
  if (!jobRow) return c.json({ error: 'Not in history' }, 404)
  const returns = await db.select().from(schema.jobReturn).where(eq(schema.jobReturn.jid, jid))
  return c.json({ job: jobRow, returns: returns.map((x) => ({ ...x, ret: x.ret ? JSON.parse(x.ret) : null })) })
})

/** Past compliance checks (dry-run highstates) with per-status minion counts. */
app.get('/api/history/compliance', async (c) => {
  if (!c.get('user')) return c.json({ error: 'Not signed in' }, 401)
  const limit = Math.min(Number(c.req.query('limit') ?? 30) || 30, 200)
  const t = schema.job
  const jobs = await db
    .select()
    .from(t)
    .where(and(eq(t.dryRun, true), or(eq(t.fun, 'state.apply'), eq(t.fun, 'state.highstate'))))
    .orderBy(desc(t.startedAt))
    .limit(limit)
  const jids = jobs.map((j) => j.jid)
  const rets = jids.length ? await db.select({ jid: schema.jobReturn.jid, summary: schema.jobReturn.summary }).from(schema.jobReturn).where(inArray(schema.jobReturn.jid, jids)) : []
  const runs = jobs.map((j) => {
    const counts = { ok: 0, drift: 0, error: 0, noreturn: 0 }
    const mine = rets.filter((x) => x.jid === j.jid)
    for (const x of mine) {
      const s = x.summary ? (JSON.parse(x.summary) as { failed: number; pending: number; changed: number }) : null
      if (!s || s.failed) counts.error++
      else if (s.pending + s.changed) counts.drift++
      else counts.ok++
    }
    const minions = JSON.parse(j.minions ?? '[]') as string[]
    counts.noreturn = Math.max(0, minions.length - mine.length)
    return { jid: j.jid, target: j.target, targetType: j.targetType, startedAt: j.startedAt, by: j.shakerUser ?? j.saltUser, args: j.args, counts }
  })
  return c.json({ runs })
})

const scheduler = new Scheduler(db, schema, salt, notifier, (row) => audit({ ...row, role: 'system' }))
scheduler.start()
app.route('/api', automationRoutes({ db, schema, scheduler, notifier, audit }))

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

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`salt-shaker ${pkg.version} listening on :${info.port} (${provider}, salt-api ${config.saltApi.url})`)
})

// release the events lease on shutdown so another instance takes over without waiting for it to expire
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, async () => {
    scheduler.stop()
    await eventsLeader.stop()
    server.close()
    process.exit(0)
  })
}
