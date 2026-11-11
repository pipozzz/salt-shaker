import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { and, count, desc, eq, inArray, or } from 'drizzle-orm'
import { Hono } from 'hono'
import { secureHeaders } from 'hono/secure-headers'
import { timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from 'hono'
import { auditCsv, auditFilter, auditWhere } from './audit'
import { CLIENT_IP_HEADER, createAuth, emailFor, USERNAME } from './auth'
import { loadConfig } from './config'
import { openDatabase } from './db'
import { HistoryRecorder } from './history'
import { INSTANCE_ID, Leader } from './leader'
import { JOB_RESULTS, jobHistory, jobsCsv } from './job-history'
import { latestCompliance, latestUpdates, minionJobs } from './minion-jobs'
import { complianceCounts } from './summaries'
import { collectMetrics, formatMetrics } from './metrics'
import { Notifier } from './notify'
import { PresenceWatcher } from './presence'
import { systemStatus } from './system'
import { OsvClient, VulnService } from './vulns'
import { automationRoutes } from './routes/automation'
import { targetRoutes } from './routes/targets'
import { queryRoutes } from './routes/queries'
import { scopeRoutes } from './routes/scopes'
import { changeRoutes } from './routes/changes'
import { tokenRoutes, userForToken } from './tokens'
import { KeyAutoAccept, keyRuleRoutes } from './keyrules'
import { recordSeen, seenRoutes } from './seen'
import { reportRoutes, WeeklyReport } from './report'
import { slackRoutes } from './slack'
import { ChangeRunner, needsApproval } from './changes'
import { cachedExpand, checkScope, loadScope } from './scope'
import { vulnRoutes } from './routes/vulns'
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
let ssoActive = !!config.oidc
const startedAt = new Date()

// Better Auth reads the OIDC discovery document once, when it is created, and drops the provider if
// that fails. If the IdP isn't reachable at start-up, keep checking and rebuild auth once it is.
if (config.oidc) {
  const discoveryUrl = config.oidc.discoveryUrl
  const reachable = () =>
    fetch(discoveryUrl, { signal: AbortSignal.timeout(5000) })
      .then((r) => r.ok)
      .catch(() => false)
  if (!(await reachable())) {
    ssoActive = false
    console.warn(`sso: ${discoveryUrl} is not reachable yet; SSO stays off until it is`)
    const retry = setInterval(async () => {
      if (!(await reachable())) return
      clearInterval(retry)
      auth = createAuth(config, db, schema, provider)
      ssoActive = true
      console.log('sso: identity provider reachable, SSO enabled')
    }, 10_000)
  }
}
const salt = new SaltService(config.saltApi)
// accepted minion ids, so minions whose key was deleted drop out of the vulnerability report
let acceptedCache: { at: number; ids: string[] } | null = null
const acceptedMinions = async () => {
  if (!acceptedCache || Date.now() - acceptedCache.at > 60_000) {
    const res = (await salt.call({ client: 'wheel', fun: 'key.list_all' })) as { data?: { return?: { minions?: string[] } } } | null
    const ids = res?.data?.return?.minions
    if (!Array.isArray(ids)) return null
    acceptedCache = { at: Date.now(), ids }
  }
  return acceptedCache.ids
}
const vulns = new VulnService(db, schema, new OsvClient(config.osvApiUrl), { minions: acceptedMinions })
const history = new HistoryRecorder(db, schema, salt, config.historyDays, config.auditDays)
const notifier = new Notifier(db, schema, config.publicUrl)
history.onEvent((tag, data) => notifier.onEvent(tag, data))
history.onReturn((r) => notifier.onReturn(r))
const weeklyReport = new WeeklyReport({ db, schema, accepted: acceptedMinions, send: (m) => notifier.emit('report', m) })
const presence = new PresenceWatcher(salt, notifier, config.presenceMinutes * 60_000, 2, (up) => recordSeen(db, schema, up))
// with several instances on one database, only the lease holder follows the event bus and watches
// for minions going down, so jobs are recorded once and alerts aren't duplicated
const eventsLeader = new Leader(db, schema, 'events', {
  onAcquire: () => {
    history.start()
    presence.start()
    weeklyReport.start()
  },
  onLose: () => {
    history.stop()
    presence.stop()
    weeklyReport.stop()
  },
})
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
  // scripts and CI use a personal API token; the web UI, its session cookie
  const bearer = /^Bearer (\S+)$/.exec(c.req.header('authorization') ?? '')?.[1]
  if (bearer) {
    const user = await userForToken(db, schema, bearer)
    if (!user) return c.json({ error: 'Invalid or expired API token' }, 401)
    c.set('user', user)
    c.set('expiresAt', null)
    c.set('via', 'token')
    return next()
  }
  const s = await auth.api.getSession({ headers: c.req.raw.headers })
  c.set('user', (s?.user as SessionUser | undefined) ?? null)
  c.set('expiresAt', s?.session.expiresAt ? new Date(s.session.expiresAt) : null)
  c.set('via', 'session')
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
    approval: config.approval,
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
    if (!USERNAME.test(username)) return c.json({ error: 'Username: 3–32 characters, letters, digits, . _ -' }, 400)
    if (!body.password || body.password.length < 10) return c.json({ error: 'Password must be at least 10 characters' }, 400)
    await auth.api.createUser({ body: { email: emailFor(username), password: body.password, name: body.name?.trim() || username, role: 'admin', data: { username } } })
    return c.json({ ok: true })
  } finally {
    settingUp = false
  }
})

app.get('/api/me', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Not signed in' }, 401)
  const role = isRole(user.role) ? user.role : 'viewer'
  // the minions they're limited to, if any, so the UI can say so
  const scope = await loadScope(db, schema, user.id)
  return c.json({ user: { id: user.id, name: user.name, username: user.username, role }, perms: ROLE_PERMS[role], scope, expiresAt: c.get('expiresAt') })
})

const audit = (row: AuditRow) => db.insert(schema.auditLog).values({ ...row, at: new Date() })

// enrollment windows accept matching new keys; the event bus is followed by one instance only
const keyAutoAccept = new KeyAutoAccept({ db, schema, salt, notify: (m) => notifier.emit('pending_key', m), audit })
history.onEvent((tag, data) => void keyAutoAccept.onEvent(tag, data).catch((e) => console.warn('keys: auto-accept failed', e)))

/** Which minions a target matches, from the master's grains cache, for scoped users' calls. */
const expandTarget = cachedExpand(async (tgt, tgtType) => Object.keys(((await salt.call({ client: 'runner', fun: 'cache.grains', tgt, tgt_type: tgtType })) ?? {}) as Record<string, unknown>))

/**
 * One salt-api call on a user's behalf, with every check the console's calls get: the role's
 * permissions, the user's scope, approvals, and the audit log. Used by /api/salt and Slack.
 */
async function saltAs(user: SessionUser, input: unknown, ip: string | null): Promise<{ status: number; body: { return?: unknown; error?: string; needsApproval?: boolean } }> {
  const username = user.username ?? user.name
  const decision = authorize(user.role, username, input)
  if (!decision.ok) {
    if (decision.status === 403 && decision.fun) {
      await audit({ userId: user.id, username, role: user.role, client: decision.client ?? '?', fun: decision.fun, outcome: 'denied', error: decision.reason, ip })
    }
    return { status: decision.status, body: { error: decision.reason } }
  }
  const { audited } = decision
  let { low } = decision
  // a scoped user runs only on their minions: the target is checked and narrowed to them
  const scope = await loadScope(db, schema, user.id)
  if (scope) {
    const narrowed = await checkScope(scope, low, expandTarget).catch((e: Error) => ({ ok: false as const, reason: `Couldn't check your access: ${e.message}` }))
    if (!narrowed.ok) {
      await audit({ userId: user.id, username, role: user.role, client: String(low.client), fun: String(low.fun), target: typeof low.tgt === 'string' ? low.tgt : null, targetType: typeof low.tgt_type === 'string' ? low.tgt_type : null, outcome: 'denied', error: narrowed.reason, ip })
      return { status: 403, body: { error: narrowed.reason } }
    }
    low = narrowed.low
  }
  // with APPROVAL_REQUIRED=risky, an operator's command that changes minions goes through a change
  if (String(low.client).startsWith('local') && needsApproval(config.approval, user.role, String(low.fun), (low.kwarg ?? {}) as Record<string, unknown>)) {
    const reason = `${String(low.fun)} needs an admin's approval: request it as a change`
    await audit({ userId: user.id, username, role: user.role, client: String(low.client), fun: String(low.fun), target: typeof low.tgt === 'string' ? low.tgt : null, targetType: typeof low.tgt_type === 'string' ? low.tgt_type : null, outcome: 'denied', error: reason, ip })
    return { status: 403, body: { error: reason, needsApproval: true } }
  }
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
    return { status: 200, body: { return: ret } }
  } catch (e) {
    const err = e instanceof UpstreamError ? e : new UpstreamError(String(e), 502)
    if (audited) await audit({ ...base, outcome: 'error', error: err.message })
    return { status: err.status, body: { error: err.message } }
  }
}

app.post('/api/salt', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Not signed in' }, 401)
  const res = await saltAs(user, await c.req.json().catch(() => null), clientIp(c))
  return c.json(res.body, res.status as 200)
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

const canReadAudit = (user: SessionUser | null) => user?.role === 'admin' || user?.role === 'operator'

app.get('/api/audit', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Not signed in' }, 401)
  if (!canReadAudit(user)) return c.json({ error: 'Admins and operators only' }, 403)
  const limit = Math.min(Number(c.req.query('limit') ?? 100) || 100, 500)
  const t = schema.auditLog
  const rows = await db.select().from(t).where(auditWhere(schema, auditFilter((k) => c.req.query(k)))).orderBy(desc(t.id)).limit(limit)
  return c.json({ rows })
})

const AUDIT_EXPORT_MAX = 100_000

app.get('/api/audit/export', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Not signed in' }, 401)
  if (!canReadAudit(user)) return c.json({ error: 'Admins and operators only' }, 403)
  const t = schema.auditLog
  const filter = { ...auditFilter((k) => c.req.query(k)), before: null }
  const rows = await db.select().from(t).where(auditWhere(schema, filter)).orderBy(desc(t.id)).limit(AUDIT_EXPORT_MAX)
  const name = `audit-${new Date().toISOString().slice(0, 10)}.csv`
  return c.body(auditCsv(rows), 200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' })
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
  const result = JOB_RESULTS.find((x) => x === c.req.query('result')) ?? null
  const rows = await jobHistory(db, schema, { q: c.req.query('q'), result, before, limit })
  return c.json({ rows, retentionDays: config.historyDays })
})

// before /:jid, which would take "export" for a jid
const JOBS_EXPORT_MAX = 100_000
app.get('/api/history/jobs/export', async (c) => {
  if (!c.get('user')) return c.json({ error: 'Not signed in' }, 401)
  const result = JOB_RESULTS.find((x) => x === c.req.query('result')) ?? null
  const rows = await jobHistory(db, schema, { q: c.req.query('q'), result, limit: JOBS_EXPORT_MAX })
  const name = `jobs-${new Date().toISOString().slice(0, 10)}.csv`
  return c.body(jobsCsv(rows), 200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' })
})

app.get('/api/history/jobs/:jid', async (c) => {
  if (!c.get('user')) return c.json({ error: 'Not signed in' }, 401)
  const jid = c.req.param('jid')
  const [jobRow] = await db.select().from(schema.job).where(eq(schema.job.jid, jid)).limit(1)
  if (!jobRow) return c.json({ error: 'Not in history' }, 404)
  const returns = await db.select().from(schema.jobReturn).where(eq(schema.jobReturn.jid, jid))
  return c.json({ job: jobRow, returns: returns.map((x) => ({ ...x, ret: x.ret ? JSON.parse(x.ret) : null })) })
})

/** Jobs that ran on one minion, with its own result in each. */
app.get('/api/history/minions/:id/jobs', async (c) => {
  if (!c.get('user')) return c.json({ error: 'Not signed in' }, 401)
  const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 200)
  const rows = await minionJobs(db, schema, c.req.param('id'), { before: Number(c.req.query('before')) || null, limit })
  return c.json({ rows, retentionDays: config.historyDays })
})

/** Each minion's result in the latest compliance check that it returned from. */
app.get('/api/history/compliance/minions', async (c) => {
  if (!c.get('user')) return c.json({ error: 'Not signed in' }, 401)
  return c.json({ minions: await latestCompliance(db, schema) })
})

/** For admins: whether salt-api, the event bus, the database and notifications work. */
app.get('/api/system', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Not signed in' }, 401)
  if (user.role !== 'admin') return c.json({ error: 'Admins only' }, 403)
  return c.json(await systemStatus({ db, schema, salt, config, version: pkg.version, instance: INSTANCE_ID, startedAt, leader: eventsLeader, stream: history.stream, ssoActive }))
})

/** Each minion's pending upgrades from the latest patch scan that it answered. */
app.get('/api/history/updates/minions', async (c) => {
  if (!c.get('user')) return c.json({ error: 'Not signed in' }, 401)
  return c.json({ minions: await latestUpdates(db, schema) })
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
    const mine = rets.filter((x) => x.jid === j.jid)
    const counts = complianceCounts(mine, (JSON.parse(j.minions ?? '[]') as string[]).length)
    return { jid: j.jid, target: j.target, targetType: j.targetType, startedAt: j.startedAt, by: j.shakerUser ?? j.saltUser, args: j.args, counts }
  })
  return c.json({ runs })
})

const scheduler = new Scheduler(db, schema, salt, notifier, (row) => audit({ ...row, role: 'system' }))
scheduler.vulns = vulns
scheduler.start()
// batched rollouts and approved changes; claims each step in the database, so every instance can run it
const changeRunner = new ChangeRunner({ db, schema, salt, notifier, audit, expand: expandTarget })
changeRunner.start()
// before automation: its admin-only middleware covers /api/* from where it's mounted
// first: Slack signs its requests instead of signing in, and targetRoutes' guard covers every /api route after it
app.route('/api', slackRoutes({ db, schema, secret: config.slackSigningSecret, publicUrl: config.publicUrl, saltAs, audit }))
app.route('/api', targetRoutes({ db, schema }))
app.route('/api', queryRoutes({ db, schema }))
app.route('/api', scopeRoutes({ db, schema, audit }))
app.route('/api', tokenRoutes({ db, schema, audit }))
app.route('/api', keyRuleRoutes({ db, schema, audit }))
app.route('/api', reportRoutes({ report: weeklyReport }))
app.route('/api', seenRoutes({ db, schema, checking: config.presenceMinutes > 0 }))
app.route('/api', changeRoutes({ db, schema, runner: changeRunner, notifier, audit, expand: expandTarget, approval: config.approval }))
app.route('/api', vulnRoutes({ vulns, audit }))
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
