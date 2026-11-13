import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { continuedSteps, continueFrom, MAX_IMPORT, mayRun, readRunbook, resolveRunbook, type ResolvedStep, type RunbookInput, type RunbookParam, type RunbookStep } from '../src/lib/runbook'
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
 *
 * Steps marked onFailure come last and run only when a step stopped the run (not when someone
 * stopped it): the run keeps running with its error set while they do, then ends as that step said.
 */

export type RunStatus = 'pending' | 'running' | 'done' | 'stopped' | 'failed' | 'rejected'
export type StepStatus = 'waiting' | 'paused' | 'starting' | 'running' | 'done' | 'failed' | 'skipped'

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
  /** a step carried over from the run this one continues: it ran there */
  fromRun?: number
  /** a step that waits to go on: who let it, and when it started waiting */
  confirmedBy?: string
  pausedAt?: string
}

type RunRow = Schema['runbookRun']['$inferSelect']
type SaltAs = (user: SessionUser, input: unknown, ip: string | null, opts?: { approved?: boolean }) => Promise<{ status: number; body: { return?: unknown; error?: string } }>

/** A step has had this long for its minions to return; the ones that didn't count as failed. */
export const STEP_DEADLINE_MS = 15 * 60_000
const START_STUCK_MS = 2 * 60_000

export function runMessage(r: Pick<RunRow, 'id' | 'name' | 'startedBy'>, what: 'pending' | 'paused' | 'done' | 'stopped' | 'failed', detail?: string | null): Message {
  const title = { pending: `Runbook "${r.name}" waits for approval`, paused: `Runbook "${r.name}" waits for you to go on`, done: `Runbook "${r.name}" finished`, stopped: `Runbook "${r.name}" stopped`, failed: `Runbook "${r.name}" failed` }[what]
  return { title, lines: [`Started by ${r.startedBy}`, ...(detail ? [detail] : [])], severity: what === 'done' ? 'info' : what === 'pending' || what === 'paused' ? 'warning' : 'error', path: `/runbooks/runs/${r.id}` }
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
    const rest = steps.map((s) => (s.status === 'waiting' || s.status === 'paused' ? { ...s, status: 'skipped' as const } : s))
    if (await this.save(r, { status, steps: JSON.stringify(rest), error, finishedAt: new Date(this.now()) })) await this.d.notifier.emit('runbook', runMessage(r, status, error))
  }

  /**
   * A step stopped the run: its steps for a failure run next, if it has any, and the run ends
   * after them with this error; otherwise it ends now. While they run, the run holds the error.
   */
  private async stopAt(r: RunRow, steps: StepState[], status: 'stopped' | 'failed', error: string) {
    const at = steps.findIndex((s) => s.onFailure && s.status === 'waiting')
    if (at < 0) return this.end(r, steps, status, error)
    const rest = steps.map((s) => (!s.onFailure && s.status === 'waiting' ? { ...s, status: 'skipped' as const } : s))
    await this.save(r, { steps: JSON.stringify(rest), error, cursor: at })
  }

  /** How the run ends once nothing is left: as the step that stopped it said, or done. */
  private finish(r: RunRow, steps: StepState[], note: string | null) {
    if (r.error) {
      // its steps for a failure have run; it ends as the step that stopped it
      const first = steps.find((s) => !s.onFailure && s.status === 'failed' && (!s.continueOnFailure || !s.jid))
      return this.end(r, steps, first && !first.jid ? 'failed' : 'stopped', r.error)
    }
    return this.end(r, steps, note ? 'stopped' : 'done', note)
  }

  /** On to the step after `i`; the steps for a failure only when a step stopped the run. */
  private async next(r: RunRow, steps: StepState[], i: number, note: string | null) {
    if (i + 1 >= steps.length || (steps[i + 1].onFailure && !r.error)) return this.finish(r, steps, note)
    await this.save(r, { steps: JSON.stringify(steps), cursor: i + 1 })
  }

  private async advance(r: RunRow) {
    const steps = JSON.parse(r.steps) as StepState[]
    const i = r.cursor
    if (i >= steps.length) return this.finish(r, steps, null)
    const step = steps[i]
    const at = () => new Date(this.now()).toISOString()
    // nothing stopped the run: its steps for a failure don't run
    if (step.onFailure && !r.error && step.status === 'waiting') return this.finish(r, steps, null)

    // a step that asks first waits, for as long as it takes, until someone lets it go on
    if (step.status === 'paused') return
    if (step.status === 'waiting' && step.confirm && !step.confirmedBy) {
      steps[i] = { ...step, status: 'paused', pausedAt: at() }
      if (await this.save(r, { steps: JSON.stringify(steps) })) await this.d.notifier.emit('runbook', runMessage(r, 'paused', `Step ${i + 1}: ${step.name}`))
      return
    }

    if (step.status === 'waiting') {
      steps[i] = { ...step, status: 'starting', startedAt: at() }
      if (!(await this.save(r, { steps: JSON.stringify(steps) }))) return
      const claimed = { ...r, version: r.version + 1 }
      const user = await this.d.loadUser(r.startedById)
      const fail = (error: string) => {
        steps[i] = { ...steps[i], status: 'failed', error, finishedAt: at() }
        // one step for a failure that can't start doesn't keep the others from running
        if (step.onFailure) return this.next(claimed, steps, i, null)
        return this.stopAt(claimed, steps, 'failed', `${step.name}: ${error}`)
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
        if (step.onFailure) return this.next(r, steps, i, null)
        return this.stopAt(r, steps, 'failed', `${step.name}: it didn't start`)
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
      if (bad && !step.continueOnFailure && !step.onFailure) {
        const who = [...failed, ...missing]
        return this.stopAt(r, steps, 'stopped', `${step.name} failed on ${who.length} ${who.length === 1 ? 'minion' : 'minions'}: ${who.slice(0, 10).join(', ')}${who.length > 10 ? ', …' : ''}`)
      }
      return this.next(r, steps, i, bad ? `${step.name} failed on some minions` : null)
    }
  }
}

const view = (r: Schema['runbook']['$inferSelect']) => ({ ...r, params: JSON.parse(r.params) as RunbookParam[], steps: JSON.parse(r.steps) as RunbookStep[], runners: JSON.parse(r.runners || '[]') as string[] })
const NOT_YOURS = 'Only admins and the operators it names run this runbook'
const runView = (r: RunRow) => ({ ...r, params: JSON.parse(r.params) as Record<string, string>, steps: JSON.parse(r.steps) as StepState[] })

export interface RouteDeps {
  db: Db
  schema: Schema
  runner: Pick<RunbookRunner, 'tick'>
  notifier: Pick<Notifier, 'emit'>
  audit: (row: AuditRow) => Promise<unknown>
  approval: 'off' | 'risky'
}

type RunbookRow = Schema['runbook']['$inferSelect']
type ScheduleRow = Schema['schedule']['$inferSelect']
export type VersionHow = 'create' | 'update' | 'import' | 'restore' | 'upgrade'

/** Someone saved the runbook between reading it and writing it. */
export class SavedMeanwhile extends Error {}

/**
 * Saves a runbook as a new version of itself (or its first), unless nothing changed: the runbook
 * row holds the latest, runbook_version every one. A save that raced another is refused.
 */
export async function saveRunbook(d: Pick<RouteDeps, 'db' | 'schema'>, existing: RunbookRow | null, rb: RunbookInput, how: VersionHow, by: string): Promise<{ row: RunbookRow; changed: boolean }> {
  const t = d.schema.runbook
  const content = { name: rb.name, description: rb.description, params: JSON.stringify(rb.params), steps: JSON.stringify(rb.steps), runners: JSON.stringify(rb.runners ?? []) }
  if (existing && (Object.keys(content) as Array<keyof typeof content>).every((k) => existing[k] === content[k])) return { row: existing, changed: false }
  const now = new Date()
  let row: RunbookRow | undefined
  if (existing) {
    ;[row] = await d.db
      .update(t)
      .set({ ...content, version: existing.version + 1, updatedAt: now })
      .where(and(eq(t.id, existing.id), eq(t.version, existing.version)))
      .returning()
    if (!row) throw new SavedMeanwhile('Someone else saved this runbook meanwhile; open it again')
  } else [row] = await d.db.insert(t).values({ ...content, version: 1, createdBy: by, updatedAt: now }).returning()
  await d.db.insert(d.schema.runbookVersion).values({ ...content, runbookId: row.id, version: row.version, how, savedBy: by, savedAt: now })
  return { row, changed: true }
}

/** Starts a run as `starter`: waiting for an admin when it needs approval, running otherwise. */
export async function startRun(d: Pick<RouteDeps, 'db' | 'schema' | 'runner' | 'notifier' | 'audit' | 'approval'>, rb: RunbookRow, given: Record<string, unknown>, starter: { userId: string; username: string; role: string | null }): Promise<{ run: RunRow } | { error: string }> {
  const resolved = resolveRunbook(view(rb), given)
  if ('error' in resolved) return { error: resolved.error! }
  // like a change: with APPROVAL_REQUIRED=risky, an operator's run with a risky step waits for an admin
  const pending = resolved.steps.some((s) => needsApproval(d.approval, starter.role, s.fun, s.kwarg))
  const steps: StepState[] = resolved.steps.map((s) => ({ ...s, status: 'waiting' }))
  const [run] = await d.db
    .insert(d.schema.runbookRun)
    .values({ runbookId: rb.id, runbookVersion: rb.version, name: rb.name, params: JSON.stringify(resolved.values), steps: JSON.stringify(steps), status: pending ? 'pending' : 'running', startedBy: starter.username, startedById: starter.userId, startedAt: new Date() })
    .returning()
  await d.audit({ userId: starter.userId, username: starter.username, role: starter.role, client: 'console', fun: 'runbook.run', target: `#${run.id} ${rb.name}`, args: JSON.stringify(resolved.values), outcome: 'ok' })
  if (pending) await d.notifier.emit('approval', runMessage(run, 'pending'))
  else await d.runner.tick()
  return { run }
}

/** What a runbook schedule runs: which runbook, with which values. */
export function readScheduleArgs(json: string | null): { runbookId: number; params: Record<string, string> } | null {
  try {
    const a = JSON.parse(json ?? '') as { runbookId?: unknown; params?: unknown }
    if (!Number.isInteger(a.runbookId)) return null
    const params = a.params && typeof a.params === 'object' ? Object.fromEntries(Object.entries(a.params).map(([k, v]) => [k, String(v ?? '')])) : {}
    return { runbookId: a.runbookId as number, params }
  } catch {
    return null
  }
}

/** Schedules that run a runbook, with the one each runs. */
export async function scheduledRunbooks(db: Db, schema: Schema) {
  const s = schema.schedule
  const rows = await db.select({ id: s.id, name: s.name, args: s.args }).from(s).where(eq(s.kind, 'runbook'))
  return rows.flatMap((r) => {
    const a = readScheduleArgs(r.args)
    return a ? [{ id: r.id, name: r.name, ...a }] : []
  })
}

/** The id a schedule's runs are started by; the schedule stands in for a person. */
export const scheduleStarter = (scheduleId: number) => `schedule:${scheduleId}`

/**
 * Who a scheduled run acts as: the schedule itself, with an admin's rights like every schedule,
 * for as long as it exists. Its steps are audited as `schedule:<name>`.
 */
export async function scheduleUser(db: Db, schema: Schema, id: string): Promise<SessionUser | null> {
  const n = Number(id.slice('schedule:'.length))
  if (!Number.isInteger(n)) return null
  const [row] = await db.select({ name: schema.schedule.name }).from(schema.schedule).where(eq(schema.schedule.id, n))
  return row ? { id, name: `schedule:${row.name}`, username: `schedule:${row.name}`, role: 'admin' } : null
}

/** Starts a runbook schedule's run, unless its last one is still going. */
export function runbookScheduler(d: Pick<RouteDeps, 'db' | 'schema' | 'runner' | 'notifier' | 'audit' | 'approval'>) {
  return async (s: ScheduleRow): Promise<{ run: number } | { error: string }> => {
    const a = readScheduleArgs(s.args)
    const [rb] = a ? await d.db.select().from(d.schema.runbook).where(eq(d.schema.runbook.id, a.runbookId)) : []
    if (!a || !rb) return { error: 'Its runbook no longer exists' }
    const runs = d.schema.runbookRun
    const starter = scheduleStarter(s.id)
    const [live] = await d.db.select({ id: runs.id }).from(runs).where(and(eq(runs.startedById, starter), inArray(runs.status, ['pending', 'running'])))
    if (live) return { error: `Its last run, #${live.id}, hasn't finished` }
    const started = await startRun(d, rb, a.params, { userId: starter, username: `schedule:${s.name}`, role: 'admin' })
    return 'error' in started ? { error: started.error } : { run: started.run.id }
  }
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
    const [existing] = id === null ? [] : await d.db.select().from(t).where(eq(t.id, id))
    if (id !== null && !existing) return c.json({ error: 'Not found' }, 404)
    const saved = await saveRunbook(d, existing ?? null, rb, id === null ? 'create' : 'update', m.username).catch((e) => e as Error)
    if (saved instanceof SavedMeanwhile) return c.json({ error: saved.message }, 409)
    if (saved instanceof Error) throw saved
    const { row, changed } = saved
    if (changed) await d.audit({ userId: m.userId, username: m.username, role: m.role, client: 'admin', fun: id === null ? 'runbook.create' : 'runbook.update', target: rb.name, args: JSON.stringify({ version: row.version, params: rb.params, steps: rb.steps, runners: rb.runners }), outcome: 'ok' })
    return c.json({ runbook: view(row) })
  }
  r.post('/runbooks', (c) => write(c, null))
  r.put('/runbooks/:id', (c) => write(c, Number(c.req.param('id'))))

  /**
   * Runbooks from a file (the page reads the YAML): all or none. Each is checked like the editor
   * checks it; one whose name is taken replaces that runbook only when the admin said so.
   */
  r.post('/runbooks/import', async (c) => {
    const m = me(c)
    if (m.role !== 'admin') return c.json({ error: 'Only admins write runbooks' }, 403)
    const body = (await c.req.json().catch(() => ({}))) as { runbooks?: unknown; replace?: unknown }
    const items = Array.isArray(body.runbooks) ? body.runbooks : []
    if (!items.length) return c.json({ error: 'There are no runbooks to import' }, 400)
    if (items.length > MAX_IMPORT) return c.json({ error: `At most ${MAX_IMPORT} runbooks at a time` }, 400)
    const read: RunbookInput[] = []
    for (const [i, item] of items.entries()) {
      const rb = readRunbook((item ?? {}) as Record<string, unknown>)
      if ('error' in rb) return c.json({ error: `Runbook ${i + 1}: ${rb.error}` }, 400)
      if (read.some((x) => x.name === rb.name)) return c.json({ error: `"${rb.name}" is there twice` }, 400)
      read.push(rb)
    }
    const existing = new Map((await d.db.select().from(t)).map((x) => [x.name, x]))
    const taken = read.filter((rb) => existing.has(rb.name)).map((rb) => rb.name)
    if (taken.length && body.replace !== true) return c.json({ error: `These already exist: ${taken.join(', ')}. Replace them, or rename them in the file`, taken }, 409)
    let created = 0
    for (const rb of read) {
      const before = existing.get(rb.name) ?? null
      const { row, changed } = await saveRunbook(d, before, rb, 'import', m.username)
      if (!before) created++
      if (changed) await d.audit({ userId: m.userId, username: m.username, role: m.role, client: 'admin', fun: 'runbook.import', target: rb.name, args: JSON.stringify({ replaced: !!before, version: row.version, params: rb.params, steps: rb.steps, runners: rb.runners }), outcome: 'ok' })
    }
    return c.json({ created, replaced: read.length - created })
  })

  r.delete('/runbooks/:id', async (c) => {
    const m = me(c)
    if (m.role !== 'admin') return c.json({ error: 'Only admins write runbooks' }, 403)
    const [row] = await d.db.select().from(t).where(eq(t.id, Number(c.req.param('id'))))
    if (!row) return c.json({ error: 'Not found' }, 404)
    const user = (await scheduledRunbooks(d.db, d.schema)).find((x) => x.runbookId === row.id)
    if (user) return c.json({ error: `The schedule "${user.name}" runs it; delete that schedule or pick another runbook for it first` }, 400)
    const [hook] = await d.db.select({ name: d.schema.runbookHook.name }).from(d.schema.runbookHook).where(eq(d.schema.runbookHook.runbookId, row.id))
    if (hook) return c.json({ error: `The webhook "${hook.name}" runs it; delete that webhook first` }, 400)
    await d.db.delete(t).where(eq(t.id, row.id))
    await d.db.delete(d.schema.runbookVersion).where(eq(d.schema.runbookVersion.runbookId, row.id))
    await d.audit({ userId: m.userId, username: m.username, role: m.role, client: 'admin', fun: 'runbook.delete', target: row.name, outcome: 'ok' })
    return c.json({ ok: true })
  })

  const versions = d.schema.runbookVersion
  const versionView = (v: Schema['runbookVersion']['$inferSelect']) => ({ ...v, params: JSON.parse(v.params) as RunbookParam[], steps: JSON.parse(v.steps) as RunbookStep[], runners: JSON.parse(v.runners || '[]') as string[] })

  /** Every saved version of a runbook, newest first. */
  r.get('/runbooks/:id/versions', async (c) => {
    const id = Number(c.req.param('id'))
    const [rb] = await d.db.select({ id: t.id }).from(t).where(eq(t.id, id))
    if (!rb) return c.json({ error: 'Not found' }, 404)
    const rows = await d.db.select().from(versions).where(eq(versions.runbookId, id)).orderBy(desc(versions.version)).limit(200)
    return c.json({ versions: rows.map(versionView) })
  })

  /** An earlier version, saved again as the newest: nothing in between is lost. */
  r.post('/runbooks/:id/versions/:version/restore', async (c) => {
    const m = me(c)
    if (m.role !== 'admin') return c.json({ error: 'Only admins write runbooks' }, 403)
    const [rb] = await d.db.select().from(t).where(eq(t.id, Number(c.req.param('id'))))
    if (!rb) return c.json({ error: 'Not found' }, 404)
    const [v] = await d.db.select().from(versions).where(and(eq(versions.runbookId, rb.id), eq(versions.version, Number(c.req.param('version')))))
    if (!v) return c.json({ error: 'There is no such version' }, 404)
    const [same] = await d.db.select({ id: t.id }).from(t).where(eq(t.name, v.name))
    if (same && same.id !== rb.id) return c.json({ error: `Another runbook is called "${v.name}" now; rename it first` }, 400)
    const saved = await saveRunbook(d, rb, versionView(v), 'restore', m.username).catch((e) => e as Error)
    if (saved instanceof SavedMeanwhile) return c.json({ error: saved.message }, 409)
    if (saved instanceof Error) throw saved
    if (!saved.changed) return c.json({ error: 'It is already like that version' }, 400)
    await d.audit({ userId: m.userId, username: m.username, role: m.role, client: 'admin', fun: 'runbook.restore', target: rb.name, args: JSON.stringify({ from: v.version, version: saved.row.version }), outcome: 'ok' })
    return c.json({ runbook: view(saved.row) })
  })

  r.post('/runbooks/:id/run', async (c) => {
    const m = me(c)
    if (m.role !== 'admin' && m.role !== 'operator') return c.json({ error: 'Viewers can read runbooks, not run them' }, 403)
    const [rb] = await d.db.select().from(t).where(eq(t.id, Number(c.req.param('id'))))
    if (!rb) return c.json({ error: 'Not found' }, 404)
    if (!mayRun(view(rb), m)) return c.json({ error: NOT_YOURS }, 403)
    const body = (await c.req.json().catch(() => ({}))) as { params?: Record<string, unknown> }
    const started = await startRun(d, rb, body.params ?? {}, { userId: m.userId, username: m.username, role: m.role })
    if ('error' in started) return c.json({ error: started.error }, 400)
    return c.json({ run: runView(started.run) }, 201)
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

  /** A new run, as whoever asks, from the step that stopped this one; the steps before stay as they ran. */
  r.post('/runbook-runs/:id/continue', async (c) => {
    const m = me(c)
    if (m.role !== 'admin' && m.role !== 'operator') return c.json({ error: 'Viewers can read runbooks, not run them' }, 403)
    const [row] = await d.db.select().from(runs).where(eq(runs.id, Number(c.req.param('id'))))
    if (!row) return c.json({ error: 'Not found' }, 404)
    const [rb] = row.runbookId === null ? [] : await d.db.select().from(t).where(eq(t.id, row.runbookId))
    if (rb && !mayRun(view(rb), m)) return c.json({ error: NOT_YOURS }, 403)
    const prev = runView(row)
    const at = continueFrom(prev)
    if (at === null) return c.json({ error: prev.status === 'stopped' || prev.status === 'failed' ? 'Every step has run; run it again instead' : 'Only a stopped or failed run can be continued' }, 400)
    const steps = continuedSteps(prev.steps, at, row.id)
    const pending = steps.slice(at).some((s) => needsApproval(d.approval, m.role, s.fun, s.kwarg))
    const [run] = await d.db
      .insert(runs)
      .values({ runbookId: row.runbookId, runbookVersion: row.runbookVersion, name: row.name, params: row.params, steps: JSON.stringify(steps), cursor: at, status: pending ? 'pending' : 'running', startedBy: m.username, startedById: m.userId, startedAt: new Date() })
      .returning()
    await d.audit({ userId: m.userId, username: m.username, role: m.role, client: 'console', fun: 'runbook.continue', target: `#${run.id} ${row.name}`, args: JSON.stringify({ from: row.id, step: at + 1 }), outcome: 'ok' })
    if (pending) await d.notifier.emit('approval', runMessage(run, 'pending'))
    else await d.runner.tick()
    return c.json({ run: runView(run) }, 201)
  })

  /** Lets a run that waits before a step go on: whoever started it, or an admin. */
  r.post('/runbook-runs/:id/proceed', async (c) => {
    const m = me(c)
    const [row] = await d.db.select().from(runs).where(eq(runs.id, Number(c.req.param('id'))))
    if (!row) return c.json({ error: 'Not found' }, 404)
    if (m.role !== 'admin' && !(m.userId === row.startedById && m.role === 'operator')) return c.json({ error: 'Only whoever started it, or an admin, lets it go on' }, 403)
    const steps = JSON.parse(row.steps) as StepState[]
    const step = steps[row.cursor]
    if (row.status !== 'running' || step?.status !== 'paused') return c.json({ error: "It isn't waiting to go on" }, 400)
    steps[row.cursor] = { ...step, status: 'waiting', confirmedBy: m.username }
    const done = await d.db
      .update(runs)
      .set({ steps: JSON.stringify(steps), version: row.version + 1 })
      .where(and(eq(runs.id, row.id), eq(runs.version, row.version)))
      .returning()
    if (!done.length) return c.json({ error: 'It changed meanwhile; try again' }, 409)
    await d.audit({ userId: m.userId, username: m.username, role: m.role, client: 'console', fun: 'runbook.proceed', target: `#${row.id} ${row.name}`, args: JSON.stringify({ step: row.cursor + 1, name: step.name }), outcome: 'ok' })
    await d.runner.tick()
    const [now] = await d.db.select().from(runs).where(eq(runs.id, row.id))
    return c.json({ run: runView(now) })
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
      const steps = (JSON.parse(row.steps) as StepState[]).map((s) => (verb !== 'approve' && (s.status === 'waiting' || s.status === 'paused') ? { ...s, status: 'skipped' as const } : s))
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
