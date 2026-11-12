import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { readRunbook, resolveRunbook, type ResolvedStep, type RunbookParam, type RunbookStep } from '../src/lib/runbook'
import { needsApproval } from './changes'
import type { Db, Schema } from './db'
import type { Notifier } from './notify'
import type { Message } from './summaries'
import type { AuditRow, Env, SessionUser } from './types'

/*
 * Runbooks run step by step, as the person who started them: each step goes through the same
 * checks as the Run page (role, scope, audit), the runner waits for its minions to return, and a
 * step that fails stops the run unless it may go on. Runs live in the database and every update is
 * claimed by its version, so any server instance can carry a run on and none takes a step twice.
 *
 *   pending ──approve──▶ running ──▶ done
 *      └──reject──▶ rejected  └──▶ stopped (a step failed, or someone stopped it)
 *                             └──▶ failed (a step couldn't start)
 */

export type RunStatus = 'pending' | 'running' | 'done' | 'stopped' | 'failed' | 'rejected'
export type StepStatus = 'waiting' | 'starting' | 'running' | 'done' | 'failed' | 'skipped'

export interface StepState extends ResolvedStep {
  status: StepStatus
  jid?: string | null
  minions?: string[]
  ok?: number
  failed?: string[]
  missing?: string[]
  startedAt?: string
  finishedAt?: string
  error?: string
}

type RunRow = Schema['runbookRun']['$inferSelect']
type SaltAs = (user: SessionUser, input: unknown, ip: string | null, opts?: { approved?: boolean }) => Promise<{ status: number; body: { return?: unknown; error?: string } }>

/** A step has had this long for its minions to return; the ones that didn't count as failed. */
export const STEP_DEADLINE_MS = 15 * 60_000
const START_STUCK_MS = 2 * 60_000

export function runMessage(r: Pick<RunRow, 'id' | 'name' | 'startedBy'>, what: 'pending' | 'done' | 'stopped' | 'failed', detail?: string | null): Message {
  const title = { pending: `Runbook "${r.name}" waits for approval`, done: `Runbook "${r.name}" finished`, stopped: `Runbook "${r.name}" stopped`, failed: `Runbook "${r.name}" failed` }[what]
  return { title, lines: [`Started by ${r.startedBy}`, ...(detail ? [detail] : [])], severity: what === 'done' ? 'info' : what === 'pending' ? 'warning' : 'error', path: `/runbooks/runs/${r.id}` }
}

interface RunnerDeps {
  db: Db
  schema: Schema
  saltAs: SaltAs
  /** the user a run acts as, if they still may run commands */
  loadUser: (id: string) => Promise<SessionUser | null>
  notifier: Pick<Notifier, 'emit'>
  now?: () => number
}

export class RunbookRunner {
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false
  private now: () => number

  constructor(private d: RunnerDeps) {
    this.now = d.now ?? Date.now
  }

  start(intervalMs = 3_000) {
    this.timer = setInterval(() => void this.tick(), intervalMs)
    void this.tick()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
  }

  async tick() {
    if (this.ticking) return
    this.ticking = true
    try {
      const t = this.d.schema.runbookRun
      for (const r of await this.d.db.select().from(t).where(eq(t.status, 'running'))) {
        try {
          await this.advance(r)
        } catch (e) {
          console.warn(`runbooks: run #${r.id} failed a step`, e)
        }
      }
    } finally {
      this.ticking = false
    }
  }

  /** Writes the run if nobody else has since it was read; false when another instance got there first. */
  private async save(r: RunRow, patch: Partial<RunRow>) {
    const t = this.d.schema.runbookRun
    const done = await this.d.db
      .update(t)
      .set({ ...patch, version: r.version + 1 })
      .where(and(eq(t.id, r.id), eq(t.version, r.version)))
      .returning({ id: t.id })
    return done.length > 0
  }

  private async end(r: RunRow, steps: StepState[], status: 'done' | 'stopped' | 'failed', error: string | null) {
    const rest = steps.map((s) => (s.status === 'waiting' ? { ...s, status: 'skipped' as const } : s))
    if (await this.save(r, { status, steps: JSON.stringify(rest), error, finishedAt: new Date(this.now()) })) await this.d.notifier.emit('runbook', runMessage(r, status, error))
  }

  private async advance(r: RunRow) {
    const steps = JSON.parse(r.steps) as StepState[]
    const i = r.cursor
    if (i >= steps.length) return this.end(r, steps, 'done', null)
    const step = steps[i]
    const at = () => new Date(this.now()).toISOString()

    if (step.status === 'waiting') {
      steps[i] = { ...step, status: 'starting', startedAt: at() }
      if (!(await this.save(r, { steps: JSON.stringify(steps) }))) return
      const claimed = { ...r, version: r.version + 1 }
      const user = await this.d.loadUser(r.startedById)
      const fail = (error: string) => {
        steps[i] = { ...steps[i], status: 'failed', error, finishedAt: at() }
        return this.end(claimed, steps, 'failed', `${step.name}: ${error}`)
      }
      if (!user) return fail(`${r.startedBy} can no longer run commands`)
      const res = await this.d.saltAs(user, { client: 'local_async', tgt: step.target, tgt_type: step.targetType, fun: step.fun, arg: step.arg, kwarg: step.kwarg }, null, { approved: !!r.decidedBy })
      if (res.status !== 200) return fail(res.body.error ?? 'salt-api refused it')
      // salt.call hands back the first return: {jid, minions} for local_async
      const started = res.body.return as { jid?: string; minions?: string[] } | null
      if (!started?.jid) return fail('No minion matched the target')
      steps[i] = { ...steps[i], status: 'running', jid: started.jid, minions: started.minions ?? [] }
      await this.save(claimed, { steps: JSON.stringify(steps) })
      return
    }

    if (step.status === 'starting') {
      // an instance that died while starting it: say so rather than run it twice
      if (this.now() - Date.parse(step.startedAt ?? '') > START_STUCK_MS) {
        steps[i] = { ...step, status: 'failed', error: "It didn't start: the server was interrupted", finishedAt: at() }
        return this.end(r, steps, 'failed', `${step.name}: it didn't start`)
      }
      return
    }

    if (step.status === 'running' && step.jid) {
      const jr = this.d.schema.jobReturn
      const rows = await this.d.db.select({ minion: jr.minion, retcode: jr.retcode, success: jr.success }).from(jr).where(eq(jr.jid, step.jid))
      const minions = step.minions ?? []
      const late = this.now() - Date.parse(step.startedAt ?? '') > STEP_DEADLINE_MS
      if (rows.length < minions.length && !late) return
      const returned = new Set(rows.map((x) => x.minion))
      const failed = rows.filter((x) => (x.retcode ?? 0) !== 0 || x.success === false).map((x) => x.minion).sort()
      const missing = minions.filter((m) => !returned.has(m)).sort()
      const bad = failed.length + missing.length
      steps[i] = { ...step, status: bad ? 'failed' : 'done', ok: rows.length - failed.length, failed, missing, finishedAt: at() }
      if (bad && !step.continueOnFailure) {
        const who = [...failed, ...missing]
        return this.end(r, steps, 'stopped', `${step.name} failed on ${who.length} ${who.length === 1 ? 'minion' : 'minions'}: ${who.slice(0, 10).join(', ')}${who.length > 10 ? ', …' : ''}`)
      }
      if (i + 1 >= steps.length) return this.end({ ...r }, steps, bad ? 'stopped' : 'done', bad ? `${step.name} failed on some minions` : null)
      await this.save(r, { steps: JSON.stringify(steps), cursor: i + 1 })
    }
  }
}

const view = (r: Schema['runbook']['$inferSelect']) => ({ ...r, params: JSON.parse(r.params) as RunbookParam[], steps: JSON.parse(r.steps) as RunbookStep[] })
const runView = (r: RunRow) => ({ ...r, params: JSON.parse(r.params) as Record<string, string>, steps: JSON.parse(r.steps) as StepState[] })

interface RouteDeps {
  db: Db
  schema: Schema
  runner: Pick<RunbookRunner, 'tick'>
  notifier: Pick<Notifier, 'emit'>
  audit: (row: AuditRow) => Promise<unknown>
  approval: 'off' | 'risky'
}

/** Everyone with a role reads runbooks and their runs; admins write them; operators and admins run them. */
export function runbookRoutes(d: RouteDeps) {
  const r = new Hono<Env>()
  const t = d.schema.runbook
  const runs = d.schema.runbookRun
  const guard = async (c: { get: (k: 'user') => Env['Variables']['user']; json: (b: unknown, s: 401 | 403) => Response }, next: () => Promise<void>) => {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Not signed in' }, 401)
    if (!user.role || user.role === 'none') return c.json({ error: 'Your account has no role yet' }, 403)
    await next()
  }
  for (const p of ['/runbooks', '/runbooks/*', '/runbook-runs', '/runbook-runs/*']) r.use(p, guard)
  const me = (c: { get: (k: 'user') => Env['Variables']['user'] }) => {
    const u = c.get('user')!
    return { user: u, userId: u.id, username: u.username ?? u.name, role: u.role ?? null }
  }

  r.get('/runbooks', async (c) => c.json({ runbooks: (await d.db.select().from(t).orderBy(asc(t.name))).map(view), approval: d.approval }))

  const write = async (c: Context<Env>, id: number | null) => {
    const m = me(c)
    if (m.role !== 'admin') return c.json({ error: 'Only admins write runbooks' }, 403)
    const rb = readRunbook((await c.req.json().catch(() => ({}))) as Record<string, unknown>)
    if ('error' in rb) return c.json({ error: rb.error }, 400)
    const [same] = await d.db.select({ id: t.id }).from(t).where(eq(t.name, rb.name))
    if (same && same.id !== id) return c.json({ error: 'A runbook with this name already exists' }, 400)
    const values = { name: rb.name, description: rb.description, params: JSON.stringify(rb.params), steps: JSON.stringify(rb.steps), updatedAt: new Date() }
    let row
    if (id === null) [row] = await d.db.insert(t).values({ ...values, createdBy: m.username }).returning()
    else {
      ;[row] = await d.db.update(t).set(values).where(eq(t.id, id)).returning()
      if (!row) return c.json({ error: 'Not found' }, 404)
    }
    await d.audit({ userId: m.userId, username: m.username, role: m.role, client: 'admin', fun: id === null ? 'runbook.create' : 'runbook.update', target: rb.name, args: JSON.stringify({ params: rb.params, steps: rb.steps }), outcome: 'ok' })
    return c.json({ runbook: view(row) })
  }
  r.post('/runbooks', (c) => write(c, null))
  r.put('/runbooks/:id', (c) => write(c, Number(c.req.param('id'))))

  r.delete('/runbooks/:id', async (c) => {
    const m = me(c)
    if (m.role !== 'admin') return c.json({ error: 'Only admins write runbooks' }, 403)
    const [row] = await d.db.select().from(t).where(eq(t.id, Number(c.req.param('id'))))
    if (!row) return c.json({ error: 'Not found' }, 404)
    await d.db.delete(t).where(eq(t.id, row.id))
    await d.audit({ userId: m.userId, username: m.username, role: m.role, client: 'admin', fun: 'runbook.delete', target: row.name, outcome: 'ok' })
    return c.json({ ok: true })
  })

  r.post('/runbooks/:id/run', async (c) => {
    const m = me(c)
    if (m.role !== 'admin' && m.role !== 'operator') return c.json({ error: 'Viewers can read runbooks, not run them' }, 403)
    const [rb] = await d.db.select().from(t).where(eq(t.id, Number(c.req.param('id'))))
    if (!rb) return c.json({ error: 'Not found' }, 404)
    const body = (await c.req.json().catch(() => ({}))) as { params?: Record<string, unknown> }
    const resolved = resolveRunbook(view(rb), body.params ?? {})
    if ('error' in resolved) return c.json({ error: resolved.error }, 400)
    // like a change: with APPROVAL_REQUIRED=risky, an operator's run with a risky step waits for an admin
    const pending = resolved.steps.some((s) => needsApproval(d.approval, m.role, s.fun, s.kwarg))
    const steps: StepState[] = resolved.steps.map((s) => ({ ...s, status: 'waiting' }))
    const [run] = await d.db
      .insert(runs)
      .values({ runbookId: rb.id, name: rb.name, params: JSON.stringify(resolved.values), steps: JSON.stringify(steps), status: pending ? 'pending' : 'running', startedBy: m.username, startedById: m.userId, startedAt: new Date() })
      .returning()
    await d.audit({ userId: m.userId, username: m.username, role: m.role, client: 'console', fun: 'runbook.run', target: `#${run.id} ${rb.name}`, args: JSON.stringify(resolved.values), outcome: 'ok' })
    if (pending) await d.notifier.emit('approval', runMessage(run, 'pending'))
    else await d.runner.tick()
    return c.json({ run: runView(run) }, 201)
  })

  r.get('/runbook-runs', async (c) => {
    const id = Number(c.req.query('runbook'))
    const q = d.db.select().from(runs)
    const rows = await (Number.isInteger(id) && id > 0 ? q.where(eq(runs.runbookId, id)) : q).orderBy(desc(runs.id)).limit(50)
    return c.json({ runs: rows.map(runView) })
  })

  r.get('/runbook-runs/:id', async (c) => {
    const [row] = await d.db.select().from(runs).where(eq(runs.id, Number(c.req.param('id'))))
    return row ? c.json({ run: runView(row) }) : c.json({ error: 'Not found' }, 404)
  })

  const act = (verb: 'stop' | 'approve' | 'reject') =>
    r.post(`/runbook-runs/:id/${verb}`, async (c) => {
      const m = me(c)
      const [row] = await d.db.select().from(runs).where(eq(runs.id, Number(c.req.param('id'))))
      if (!row) return c.json({ error: 'Not found' }, 404)
      if (verb === 'stop') {
        if (m.role !== 'admin' && m.userId !== row.startedById) return c.json({ error: 'Only whoever started it, or an admin, stops it' }, 403)
        if (!['pending', 'running'].includes(row.status)) return c.json({ error: 'It has already finished' }, 400)
      } else {
        if (m.role !== 'admin') return c.json({ error: 'Only admins approve runbook runs' }, 403)
        if (m.userId === row.startedById) return c.json({ error: 'Someone else has to approve your run' }, 403)
        if (row.status !== 'pending') return c.json({ error: "It isn't waiting for approval" }, 400)
      }
      const steps = (JSON.parse(row.steps) as StepState[]).map((s) => (verb !== 'approve' && s.status === 'waiting' ? { ...s, status: 'skipped' as const } : s))
      const patch =
        verb === 'approve'
          ? { status: 'running', decidedBy: m.username }
          : verb === 'reject'
            ? { status: 'rejected', decidedBy: m.username, finishedAt: new Date(), steps: JSON.stringify(steps) }
            : { status: 'stopped', error: `Stopped by ${m.username}`, finishedAt: new Date(), steps: JSON.stringify(steps) }
      const done = await d.db
        .update(runs)
        .set({ ...patch, version: row.version + 1 })
        .where(and(eq(runs.id, row.id), eq(runs.version, row.version), inArray(runs.status, verb === 'stop' ? ['pending', 'running'] : ['pending'])))
        .returning()
      if (!done.length) return c.json({ error: 'It changed meanwhile; reload and try again' }, 409)
      await d.audit({ userId: m.userId, username: m.username, role: m.role, client: 'console', fun: `runbook.${verb}`, target: `#${row.id} ${row.name}`, outcome: 'ok' })
      if (verb === 'approve') await d.runner.tick()
      return c.json({ run: runView(done[0]) })
    })
  act('stop')
  act('approve')
  act('reject')

  return r
}
