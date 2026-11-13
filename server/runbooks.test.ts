import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import type { RunbookInput } from '../src/lib/runbook'
import { automationRoutes } from './routes/automation'
import { Scheduler } from './scheduler'
import type { Notifier } from './notify'
import type { SaltService } from './salt'
import { runbookRoutes, RunbookRunner, runbookScheduler, scheduleUser, type StepState } from './runbooks'
import { openTestDatabase, testDialects } from './testdb'
import type { Env, SessionUser } from './types'

const ada: SessionUser = { id: 'a', name: 'Ada', username: 'ada', role: 'admin' }
const olga: SessionUser = { id: 'o', name: 'Olga', username: 'olga', role: 'operator' }
const vic: SessionUser = { id: 'v', name: 'Vic', username: 'vic', role: 'viewer' }

const restart: RunbookInput = {
  name: 'Restart a service',
  description: 'Checks the config first',
  params: [
    { name: 'host', label: 'Minion', default: '', required: true },
    { name: 'service', label: 'Service', default: 'nginx', required: true },
  ],
  steps: [
    { name: 'Check config', fun: 'cmd.run', target: '{{host}}', targetType: 'glob', args: "'{{service}} -t'", continueOnFailure: false },
    { name: 'Restart', fun: 'service.restart', target: '{{host}}', targetType: 'glob', args: '{{service}}', continueOnFailure: false },
    { name: 'Status', fun: 'service.status', target: '{{host}}', targetType: 'glob', args: '{{service}}', continueOnFailure: false },
  ],
}

describe.each(testDialects)('runbooks (%s)', (dialect) => {
  let close: (() => Promise<unknown>) | null = null
  afterEach(async () => {
    await close?.()
    close = null
  })

  async function setup(approval: 'off' | 'risky' = 'off') {
    const opened = await openTestDatabase(dialect)
    close = opened.close
    const { db, schema } = opened
    const calls: Array<{ user: string; low: Record<string, unknown>; approved: boolean }> = []
    let jid = 0
    // web-* matches two minions; "nowhere" matches none; olga may not touch db-*
    const saltAs = async (user: SessionUser, input: unknown, _ip: string | null, opts: { approved?: boolean } = {}) => {
      const low = input as Record<string, unknown>
      calls.push({ user: user.username!, low, approved: !!opts.approved })
      if (user.role !== 'admin' && String(low.tgt).startsWith('db-')) return { status: 403, body: { error: 'db-01 is outside your scope' } }
      if (low.tgt === 'nowhere') return { status: 200, body: { return: '' } }
      return { status: 200, body: { return: { jid: `j${++jid}`, minions: String(low.tgt) === 'web-*' ? ['web-01', 'web-02'] : [String(low.tgt)] } } }
    }
    const emitted: string[] = []
    const notifier = { emit: async (event: string, msg: { title: string }) => void emitted.push(`${event}: ${msg.title}`) }
    const users: Record<string, SessionUser> = { a: ada, o: olga }
    let now = Date.parse('2026-11-12T10:00:00Z')
    const runner = new RunbookRunner({ db, schema, saltAs, loadUser: async (id) => (id.startsWith('schedule:') ? scheduleUser(db, schema, id) : (users[id] ?? null)), notifier, now: () => now })
    const audited: string[] = []
    let user: SessionUser | null = null
    const app = new Hono<Env>()
    app.use('*', async (c, next) => {
      c.set('user', user)
      await next()
    })
    const deps = { db, schema, runner, notifier, audit: async (r: { username: string; fun: string; target?: string | null }) => void audited.push(`${r.username} ${r.fun} ${r.target}`), approval }
    app.route('/api', runbookRoutes(deps))
    const call = async (as: SessionUser | null, method: string, path: string, body?: unknown) => {
      user = as
      const res = await app.request(`/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      return { status: res.status, body: (await res.json()) as Record<string, unknown> }
    }
    const returns = async (j: string, minions: Array<[string, boolean]>) => {
      await db.insert(schema.jobReturn).values(minions.map(([minion, ok]) => ({ jid: j, minion, success: ok, retcode: ok ? 0 : 1, returnedAt: new Date() })))
    }
    const run = async (id: number) => (await call(ada, 'GET', `/runbook-runs/${id}`)).body.run as { status: string; cursor: number; error: string | null; steps: StepState[] }
    return { db, schema, deps, call, calls, returns, run, runner, emitted, audited, advance: (ms: number) => (now += ms) }
  }

  it('admins write runbooks, everyone with a role reads them, viewers do not run them', async () => {
    const { call, audited } = await setup()
    expect((await call(null, 'GET', '/runbooks')).status).toBe(401)
    expect((await call(olga, 'POST', '/runbooks', restart)).status).toBe(403)
    expect(await call(ada, 'POST', '/runbooks', { ...restart, steps: [] })).toEqual({ status: 400, body: { error: 'Add at least one step' } })
    const made = await call(ada, 'POST', '/runbooks', restart)
    const id = (made.body.runbook as { id: number }).id
    expect((await call(ada, 'POST', '/runbooks', restart)).body).toEqual({ error: 'A runbook with this name already exists' })
    expect(((await call(vic, 'GET', '/runbooks')).body.runbooks as RunbookInput[])[0]).toMatchObject(restart)
    expect((await call(vic, 'POST', `/runbooks/${id}/run`, { params: { host: 'web-01' } })).status).toBe(403)
    expect(await call(olga, 'POST', `/runbooks/${id}/run`, { params: {} })).toEqual({ status: 400, body: { error: 'Minion is required' } })
    const edited = await call(ada, 'PUT', `/runbooks/${id}`, { ...restart, description: 'v2' })
    expect(edited.body.runbook).toMatchObject({ description: 'v2' })
    expect((await call(ada, 'DELETE', `/runbooks/${id}`)).status).toBe(200)
    expect(audited).toEqual(['ada runbook.create Restart a service', 'ada runbook.update Restart a service', 'ada runbook.delete Restart a service'])
  })

  it('runs the steps in order as the operator, waiting for the minions, and stops when one fails', async () => {
    const { call, calls, returns, run, runner, emitted } = await setup()
    const id = ((await call(ada, 'POST', '/runbooks', restart)).body.runbook as { id: number }).id
    const started = await call(olga, 'POST', `/runbooks/${id}/run`, { params: { host: 'web-*' } })
    expect(started.status).toBe(201)
    const runId = (started.body.run as { id: number }).id

    // step 1 started right away, as olga, with the values filled in
    expect(calls).toEqual([{ user: 'olga', low: { client: 'local_async', tgt: 'web-*', tgt_type: 'glob', fun: 'cmd.run', arg: ['nginx -t'], kwarg: {} }, approved: false }])
    await runner.tick()
    expect((await run(runId)).steps[0]).toMatchObject({ status: 'running', jid: 'j1', minions: ['web-01', 'web-02'] })
    // one minion back: still waiting
    await returns('j1', [['web-01', true]])
    await runner.tick()
    expect((await run(runId)).cursor).toBe(0)
    await returns('j1', [['web-02', true]])
    await runner.tick() // step 1 done
    await runner.tick() // step 2 starts
    expect(calls.at(-1)!.low).toMatchObject({ fun: 'service.restart', arg: ['nginx'] })
    await returns('j2', [['web-01', true], ['web-02', false]])
    await runner.tick()
    const stopped = await run(runId)
    expect(stopped.status).toBe('stopped')
    expect(stopped.error).toBe('Restart failed on 1 minion: web-02')
    expect(stopped.steps.map((s) => s.status)).toEqual(['done', 'failed', 'skipped'])
    expect(stopped.steps[1]).toMatchObject({ ok: 1, failed: ['web-02'], missing: [] })
    expect(calls).toHaveLength(2)
    expect(emitted).toEqual(['runbook: Runbook "Restart a service" stopped'])
  })

  it('continues a stopped run from the step that stopped it, as whoever asks, keeping what ran before', async () => {
    const { call, calls, returns, run, runner, audited } = await setup()
    const id = ((await call(ada, 'POST', '/runbooks', restart)).body.runbook as { id: number }).id
    const first = ((await call(olga, 'POST', `/runbooks/${id}/run`, { params: { host: 'web-01' } })).body.run as { id: number }).id
    await call(olga, 'POST', `/runbook-runs/${first}/continue`).then((r) => expect(r).toEqual({ status: 400, body: { error: 'Only a stopped or failed run can be continued' } }))
    await runner.tick()
    await returns('j1', [['web-01', true]])
    await runner.tick()
    await runner.tick()
    await returns('j2', [['web-01', false]])
    await runner.tick()
    expect((await run(first)).status).toBe('stopped')

    expect((await call(vic, 'POST', `/runbook-runs/${first}/continue`)).status).toBe(403)
    const res = await call(ada, 'POST', `/runbook-runs/${first}/continue`)
    expect(res.status).toBe(201)
    const next = res.body.run as { id: number; cursor: number; startedBy: string; params: Record<string, string>; steps: StepState[] }
    expect(next).toMatchObject({ cursor: 1, startedBy: 'ada', params: { host: 'web-01', service: 'nginx' } })
    expect(next.steps[0]).toMatchObject({ status: 'done', jid: 'j1', fromRun: first })
    expect(next.steps[1]).toEqual(expect.objectContaining({ status: 'waiting' }))
    expect(next.steps[1]).not.toHaveProperty('jid')
    // the stopped step runs again, as ada; the first doesn't
    expect(calls.map((c) => `${c.user} ${c.low.fun}`)).toEqual(['olga cmd.run', 'olga service.restart', 'ada service.restart'])
    await returns('j3', [['web-01', true]])
    await runner.tick()
    await runner.tick()
    await returns('j4', [['web-01', true]])
    await runner.tick()
    expect((await run(next.id)).steps.map((s) => s.status)).toEqual(['done', 'done', 'done'])
    expect((await run(next.id)).status).toBe('done')
    expect(audited.at(-1)).toBe(`ada runbook.continue #${next.id} Restart a service`)
    // the stopped run itself is as it was
    expect((await run(first)).steps.map((s) => s.status)).toEqual(['done', 'failed', 'skipped'])
  })

  it('runs the steps for a failure only when a step stopped the run, then ends as that step said', async () => {
    const { call, calls, returns, run, runner, emitted } = await setup()
    const rb = { ...restart, steps: [...restart.steps.slice(0, 2), { name: 'Start it', fun: 'service.start', target: '{{host}}', targetType: 'glob', args: '{{service}}', continueOnFailure: false, onFailure: true }, { name: 'Tell', fun: 'event.send', target: '{{host}}', targetType: 'glob', args: 'restart/failed', continueOnFailure: false, onFailure: true }] }
    const id = ((await call(ada, 'POST', '/runbooks', rb)).body.runbook as { id: number }).id
    expect((await call(ada, 'POST', '/runbooks', { ...rb, name: 'x', steps: [rb.steps[2], rb.steps[0]] })).body).toEqual({ error: 'Step 2 runs every time, so it comes before the steps for a failure' })

    // all well: they're skipped
    const ok = ((await call(olga, 'POST', `/runbooks/${id}/run`, { params: { host: 'web-01' } })).body.run as { id: number }).id
    await returns('j1', [['web-01', true]])
    await runner.tick()
    await runner.tick()
    await returns('j2', [['web-01', true]])
    await runner.tick()
    expect(await run(ok)).toMatchObject({ status: 'done', error: null })
    expect((await run(ok)).steps.map((s) => s.status)).toEqual(['done', 'done', 'skipped', 'skipped'])

    // the restart fails: the run holds the error while they run, one failing doesn't stop the other
    const bad = ((await call(olga, 'POST', `/runbooks/${id}/run`, { params: { host: 'web-01' } })).body.run as { id: number }).id
    await returns('j3', [['web-01', true]])
    await runner.tick()
    await runner.tick()
    await returns('j4', [['web-01', false]])
    await runner.tick()
    expect(await run(bad)).toMatchObject({ status: 'running', cursor: 2, error: 'Restart failed on 1 minion: web-01' })
    await runner.tick()
    expect(calls.at(-1)).toMatchObject({ user: 'olga', low: { fun: 'service.start', arg: ['nginx'] } })
    await returns('j5', [['web-01', false]])
    await runner.tick()
    await runner.tick()
    await returns('j6', [['web-01', true]])
    await runner.tick()
    const ended = await run(bad)
    expect(ended).toMatchObject({ status: 'stopped', error: 'Restart failed on 1 minion: web-01' })
    expect(ended.steps.map((s) => s.status)).toEqual(['done', 'failed', 'failed', 'done'])
    expect(emitted.at(-1)).toBe('runbook: Runbook "Restart a service" stopped')
  })

  it('waits before a step that asks first until whoever started it, or an admin, lets it go on', async () => {
    const { call, calls, returns, run, runner, emitted, audited } = await setup()
    const rb = { ...restart, steps: [restart.steps[0], { ...restart.steps[1], confirm: true }, restart.steps[2]] }
    const id = ((await call(ada, 'POST', '/runbooks', rb)).body.runbook as { id: number }).id
    const runId = ((await call(olga, 'POST', `/runbooks/${id}/run`, { params: { host: 'web-01' } })).body.run as { id: number }).id
    await returns('j1', [['web-01', true]])
    await runner.tick()
    await runner.tick()
    // it waits, as long as it takes, and says so
    await runner.tick()
    expect((await run(runId)).steps.map((s) => s.status)).toEqual(['done', 'paused', 'waiting'])
    expect(calls).toHaveLength(1)
    expect(emitted).toEqual(['runbook: Runbook "Restart a service" waits for you to go on'])

    const bob: SessionUser = { id: 'b', name: 'Bob', username: 'bob', role: 'operator' }
    expect(await call(bob, 'POST', `/runbook-runs/${runId}/proceed`)).toEqual({ status: 403, body: { error: 'Only whoever started it, or an admin, lets it go on' } })
    const res = await call(olga, 'POST', `/runbook-runs/${runId}/proceed`)
    expect(res.status).toBe(200)
    expect((res.body.run as { steps: StepState[] }).steps[1]).toMatchObject({ status: 'running', confirmedBy: 'olga', jid: 'j2' })
    expect(calls.at(-1)).toMatchObject({ user: 'olga', low: { fun: 'service.restart' } })
    expect(audited.at(-1)).toBe(`olga runbook.proceed #${runId} Restart a service`)
    expect((await call(olga, 'POST', `/runbook-runs/${runId}/proceed`)).body).toEqual({ error: "It isn't waiting to go on" })
    await returns('j2', [['web-01', true]])
    await runner.tick()
    await runner.tick()
    await returns('j3', [['web-01', true]])
    await runner.tick()
    expect((await run(runId)).status).toBe('done')

    // stopped while it waits: the step is skipped
    const second = ((await call(olga, 'POST', `/runbooks/${id}/run`, { params: { host: 'web-01' } })).body.run as { id: number }).id
    await returns('j4', [['web-01', true]])
    await runner.tick()
    await runner.tick()
    await runner.tick()
    await call(ada, 'POST', `/runbook-runs/${second}/stop`)
    expect((await run(second)).steps.map((s) => s.status)).toEqual(['done', 'skipped', 'skipped'])
  })

  it('runs only for admins and the operators it names, when it names any', async () => {
    const { call, audited } = await setup()
    const bob: SessionUser = { id: 'b', name: 'Bob', username: 'bob', role: 'operator' }
    const made = await call(ada, 'POST', '/runbooks', { ...restart, runners: ['olga'] })
    const id = (made.body.runbook as { id: number; runners: string[] }).id
    expect(made.body.runbook).toMatchObject({ runners: ['olga'] })
    expect(audited.at(-1)).toBe('ada runbook.create Restart a service')
    expect(await call(bob, 'POST', `/runbooks/${id}/run`, { params: { host: 'web-01' } })).toEqual({ status: 403, body: { error: 'Only admins and the operators it names run this runbook' } })
    expect((await call(olga, 'POST', `/runbooks/${id}/run`, { params: { host: 'web-01' } })).status).toBe(201)
    expect((await call(ada, 'POST', `/runbooks/${id}/run`, { params: { host: 'web-01' } })).status).toBe(201)
    // everyone sees whom it names
    expect(((await call(vic, 'GET', '/runbooks')).body.runbooks as Array<{ runners: string[] }>)[0].runners).toEqual(['olga'])
    // naming none again: every operator
    await call(ada, 'PUT', `/runbooks/${id}`, { ...restart, runners: [] })
    expect((await call(bob, 'POST', `/runbooks/${id}/run`, { params: { host: 'web-01' } })).status).toBe(201)
  })

  it('admins import runbooks from a file: all or none, replacing only when asked', async () => {
    const { call, audited } = await setup()
    await call(ada, 'POST', '/runbooks', restart)
    const ping = { name: 'Ping', steps: [{ fun: 'test.ping', target: '*' }] }
    expect((await call(olga, 'POST', '/runbooks/import', { runbooks: [ping] })).status).toBe(403)
    expect(await call(ada, 'POST', '/runbooks/import', { runbooks: [ping, { name: 'Bad', steps: [] }] })).toEqual({ status: 400, body: { error: 'Runbook 2: Add at least one step' } })
    expect(await call(ada, 'POST', '/runbooks/import', { runbooks: [ping, ping] })).toEqual({ status: 400, body: { error: '"Ping" is there twice' } })
    const changed = { ...restart, description: 'From git', runners: ['olga'] }
    expect(await call(ada, 'POST', '/runbooks/import', { runbooks: [ping, changed] })).toEqual({ status: 409, body: { error: 'These already exist: Restart a service. Replace them, or rename them in the file', taken: ['Restart a service'] } })
    // nothing was written
    expect(((await call(ada, 'GET', '/runbooks')).body.runbooks as unknown[]).length).toBe(1)
    expect(await call(ada, 'POST', '/runbooks/import', { runbooks: [ping, changed], replace: true })).toEqual({ status: 200, body: { created: 1, replaced: 1 } })
    const listed = (await call(ada, 'GET', '/runbooks')).body.runbooks as Array<{ name: string; description: string; runners: string[] }>
    expect(listed.map((x) => [x.name, x.description, x.runners])).toEqual([['Ping', '', []], ['Restart a service', 'From git', ['olga']]])
    expect(audited.slice(-2)).toEqual(['ada runbook.import Ping', 'ada runbook.import Restart a service'])
  })

  it('keeps every saved version, runs record theirs, and admins restore an earlier one', async () => {
    const { call, audited } = await setup()
    const id = ((await call(ada, 'POST', '/runbooks', restart)).body.runbook as { id: number; version: number }).id
    await call(ada, 'PUT', `/runbooks/${id}`, { ...restart, description: 'Second' })
    // saving it unchanged makes no version
    await call(ada, 'PUT', `/runbooks/${id}`, { ...restart, description: 'Second' })
    const run = (await call(olga, 'POST', `/runbooks/${id}/run`, { params: { host: 'web-01' } })).body.run as { runbookVersion: number }
    expect(run.runbookVersion).toBe(2)
    await call(ada, 'POST', '/runbooks/import', { runbooks: [{ ...restart, description: 'From git' }], replace: true })
    const listed = (await call(vic, 'GET', `/runbooks/${id}/versions`)).body.versions as Array<{ version: number; how: string; savedBy: string; description: string }>
    expect(listed.map((v) => [v.version, v.how, v.savedBy, v.description])).toEqual([
      [3, 'import', 'ada', 'From git'],
      [2, 'update', 'ada', 'Second'],
      [1, 'create', 'ada', 'Checks the config first'],
    ])

    expect((await call(olga, 'POST', `/runbooks/${id}/versions/1/restore`)).status).toBe(403)
    expect((await call(ada, 'POST', `/runbooks/${id}/versions/9/restore`)).status).toBe(404)
    const restored = await call(ada, 'POST', `/runbooks/${id}/versions/1/restore`)
    expect(restored.body.runbook).toMatchObject({ version: 4, description: 'Checks the config first' })
    expect(audited.at(-1)).toBe('ada runbook.restore Restart a service')
    expect(await call(ada, 'POST', `/runbooks/${id}/versions/4/restore`)).toEqual({ status: 400, body: { error: 'It is already like that version' } })
    expect(((await call(ada, 'GET', `/runbooks/${id}/versions`)).body.versions as Array<{ how: string }>)[0].how).toBe('restore')

    // its versions go with it
    await call(ada, 'DELETE', `/runbooks/${id}`)
    expect((await call(ada, 'GET', `/runbooks/${id}/versions`)).status).toBe(404)
  })

  it("goes on past a step that may fail, counts minions that never answer, and fails a step that can't start", async () => {
    const { call, returns, run, runner, advance } = await setup()
    const lenient = { ...restart, name: 'Lenient', steps: restart.steps.map((s, i) => ({ ...s, continueOnFailure: i === 0 })) }
    const id = ((await call(ada, 'POST', '/runbooks', lenient)).body.runbook as { id: number }).id
    const runId = ((await call(olga, 'POST', `/runbooks/${id}/run`, { params: { host: 'web-*' } })).body.run as { id: number }).id
    await returns('j1', [['web-01', false]])
    advance(16 * 60_000) // web-02 never answers
    await runner.tick()
    expect((await run(runId)).steps[0]).toMatchObject({ status: 'failed', failed: ['web-01'], missing: ['web-02'] })
    await runner.tick()
    expect((await run(runId)).steps[1].status).toBe('running')

    // outside the operator's scope: the step can't start, and the run fails with why
    const scoped = ((await call(olga, 'POST', `/runbooks/${id}/run`, { params: { host: 'db-01' } })).body.run as { id: number }).id
    await runner.tick()
    const r = await run(scoped)
    expect(r.status).toBe('failed')
    expect(r.error).toBe('Check config: db-01 is outside your scope')
    // and a target that matches nothing
    const none = ((await call(olga, 'POST', `/runbooks/${id}/run`, { params: { host: 'nowhere' } })).body.run as { id: number }).id
    expect((await run(none)).error).toBe('Check config: No minion matched the target')
  })

  it("with approval on, an operator's risky run waits for another admin, then runs as approved", async () => {
    const { call, calls, run, emitted, audited } = await setup('risky')
    const id = ((await call(ada, 'POST', '/runbooks', restart)).body.runbook as { id: number }).id
    const runId = ((await call(olga, 'POST', `/runbooks/${id}/run`, { params: { host: 'web-01' } })).body.run as { id: number }).id
    expect((await run(runId)).status).toBe('pending')
    expect(calls).toHaveLength(0)
    expect(emitted).toEqual(['approval: Runbook "Restart a service" waits for approval'])
    expect((await call(olga, 'POST', `/runbook-runs/${runId}/approve`)).status).toBe(403)
    expect((await call(ada, 'POST', `/runbook-runs/${runId}/approve`)).status).toBe(200)
    expect(calls[0]).toMatchObject({ user: 'olga', approved: true })
    // whoever started it stops it
    expect((await call(olga, 'POST', `/runbook-runs/${runId}/stop`)).body.run).toMatchObject({ status: 'stopped', error: 'Stopped by olga' })
    expect(audited.slice(-3)).toEqual([`olga runbook.run #${runId} Restart a service`, `ada runbook.approve #${runId} Restart a service`, `olga runbook.stop #${runId} Restart a service`])
    // an admin's own run needs no approval
    const own = ((await call(ada, 'POST', `/runbooks/${id}/run`, { params: { host: 'web-01' } })).body.run as { id: number }).id
    expect((await run(own)).status).toBe('running')
  })

  it('a schedule runs a runbook as itself, one run at a time, and keeps its runbook from being deleted', async () => {
    const { db, schema, deps, call, calls, returns, run, runner, audited } = await setup('risky')
    const id = ((await call(ada, 'POST', '/runbooks', restart)).body.runbook as { id: number }).id
    const [s] = await db
      .insert(schema.schedule)
      .values({ name: 'Nightly restart', kind: 'runbook', target: '', targetType: 'glob', cron: '0 3 * * *', args: JSON.stringify({ runbookId: id, params: { host: 'web-*' } }), createdAt: new Date() })
      .returning()
    const start = runbookScheduler(deps)

    // an admin's rights, like every schedule: nothing waits for approval
    const first = await start(s)
    expect(first).toEqual({ run: expect.any(Number) })
    const runId = (first as { run: number }).run
    expect(await run(runId)).toMatchObject({ status: 'running', startedBy: 'schedule:Nightly restart' })
    expect(calls[0]).toMatchObject({ user: 'schedule:Nightly restart', low: { tgt: 'web-*', arg: ['nginx -t'] } })
    expect(audited.at(-1)).toBe(`schedule:Nightly restart runbook.run #${runId} Restart a service`)
    expect(await start(s)).toEqual({ error: `Its last run, #${runId}, hasn't finished` })

    expect(await call(ada, 'DELETE', `/runbooks/${id}`)).toEqual({ status: 400, body: { error: 'The schedule "Nightly restart" runs it; delete that schedule or pick another runbook for it first' } })

    // once the schedule is gone, its run can't go on as it
    await db.delete(schema.schedule)
    await returns('j1', [['web-01', true], ['web-02', true]])
    await runner.tick()
    await runner.tick()
    expect(await run(runId)).toMatchObject({ status: 'failed', error: 'Restart: schedule:Nightly restart can no longer run commands' })
    expect(await start({ ...s, args: JSON.stringify({ runbookId: 999, params: {} }) })).toEqual({ error: 'Its runbook no longer exists' })
  })

  it('admins set a schedule to run a runbook with its values, and see how its runs went', async () => {
    const { db, schema, deps, call } = await setup()
    const id = ((await call(ada, 'POST', '/runbooks', restart)).body.runbook as { id: number }).id
    const scheduler = new Scheduler(db, schema, {} as SaltService, deps.notifier as unknown as Notifier, async () => undefined)
    scheduler.runbooks = runbookScheduler(deps)
    const app = new Hono<Env>()
    app.use('*', async (c, next) => {
      c.set('user', ada)
      await next()
    })
    app.route('/api', automationRoutes({ db, schema, scheduler, notifier: deps.notifier as unknown as Notifier, audit: async () => undefined }))
    const req = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(`/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      return { status: res.status, body: (await res.json()) as Record<string, unknown> }
    }
    const schedule = (args: unknown) => ({ name: 'Nightly restart', kind: 'runbook', cron: '0 3 * * *', args })
    expect(await req('POST', '/schedules', schedule({ runbookId: 999, params: {} }))).toEqual({ status: 400, body: { error: 'Choose a runbook' } })
    expect(await req('POST', '/schedules', schedule({ runbookId: id, params: {} }))).toEqual({ status: 400, body: { error: 'Minion is required' } })
    const made = await req('POST', '/schedules', schedule({ runbookId: id, params: { host: 'web-01' } }))
    expect(made.status).toBe(200)
    const sid = (made.body.schedule as { id: number }).id

    const started = await req('POST', `/schedules/${sid}/run`)
    expect(started.body).toEqual({ run: expect.any(Number) })
    const [listed] = (await req('GET', '/schedules')).body.schedules as Array<Record<string, unknown>>
    expect(listed).toMatchObject({ runbookName: 'Restart a service', target: '', args: { runbookId: id, params: { host: 'web-01' } }, lastSummary: { run: started.body.run, status: 'running' } })
    expect(listed.recentRuns).toEqual([{ jid: `run:${started.body.run}`, run: started.body.run, startedAt: expect.anything(), status: 'running', detail: 'running' }])
    // its last run hasn't finished: no second one, and the schedule says why
    expect((await req('POST', `/schedules/${sid}/run`)).status).toBe(502)
    const [again] = (await req('GET', '/schedules')).body.schedules as Array<{ lastSummary: unknown }>
    expect(again.lastSummary).toEqual({ error: `Its last run, #${started.body.run}, hasn't finished` })
  })
})
