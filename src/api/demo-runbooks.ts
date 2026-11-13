import { continuedSteps, continueFrom, readRunbook, resolveRunbook, type RunbookInput } from '../lib/runbook'
import { readCallValues, readHookSettings } from '../lib/runbook-hook'
import { recordDemoAudit } from './demo-audit'
import { demoJob, demoJobProgress } from './mock'
import type { HookCall, Runbook, RunbookHook, RunbookRun, RunbookStepState, runbookHooks, runbooks } from './server'

/*
 * Runbooks in the demo: two to try, kept in the browser. A run works through its steps on the
 * simulated master like the server's runner: one at a time, waiting for the minions, stopping
 * when a step fails. The demo user is an admin, so nothing waits for approval.
 */

const delay = <T>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 120))
const fail = (m: string) => Promise.reject(new Error(m))
const STEP_WAIT_MS = 20_000

const SEED: RunbookInput[] = [
  {
    name: 'Restart a service safely',
    description: 'Checks the configuration first, restarts the service only if it is valid, then makes sure it runs; if the restart fails, starts it again.',
    params: [
      { name: 'host', label: 'Minions', default: 'web-01', required: true },
      { name: 'service', label: 'Service', default: 'nginx', required: true },
    ],
    steps: [
      { name: 'Check the configuration', fun: 'cmd.run', target: '{{host}}', targetType: 'glob', args: "'{{service}} -t'", continueOnFailure: false },
      { name: 'Restart', fun: 'service.restart', target: '{{host}}', targetType: 'glob', args: '{{service}}', continueOnFailure: false },
      { name: 'Make sure it runs', fun: 'service.status', target: '{{host}}', targetType: 'glob', args: '{{service}}', continueOnFailure: false },
      { name: 'Start it again', fun: 'service.start', target: '{{host}}', targetType: 'glob', args: '{{service}}', continueOnFailure: false, onFailure: true },
    ],

    runners: ['olga'],
  },
  {
    name: 'Sync and apply the highstate',
    description: 'Syncs custom modules, shows what the highstate would change, and applies it once you have looked.',
    params: [{ name: 'target', label: 'Minions', default: 'web-*', required: true }],
    steps: [
      { name: 'Sync modules', fun: 'saltutil.sync_all', target: '{{target}}', targetType: 'glob', args: '', continueOnFailure: false },
      { name: 'Dry run', fun: 'state.apply', target: '{{target}}', targetType: 'glob', args: 'test=True', continueOnFailure: true },
      { name: 'Apply', fun: 'state.apply', target: '{{target}}', targetType: 'glob', args: '', continueOnFailure: false, confirm: true },
    ],
  },
]

let nextId = 1
const list: Runbook[] = SEED.map((rb) => ({ ...rb, id: nextId++, createdBy: 'pam', updatedAt: new Date(Date.now() - 6 * 86400_000).toISOString() }))
let nextRun = 1
const runs: RunbookRun[] = []
const copy = (r: RunbookRun): RunbookRun => ({ ...r, steps: r.steps.map((s) => ({ ...s })) })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Works through a run's steps on the simulated master, like the server's runner. */
async function work(run: RunbookRun) {
  for (let i = run.cursor; i < run.steps.length; i++) {
    if (run.status !== 'running') return
    const step = run.steps[i]
    // nothing stopped the run: its steps for a failure don't run
    if (step.onFailure && !run.error) break
    run.cursor = i
    // a step that asks first waits until someone lets it go on
    if (step.confirm && !step.confirmedBy) {
      Object.assign(step, { status: 'paused', pausedAt: new Date().toISOString() })
      while (!step.confirmedBy) {
        await sleep(400)
        if (run.status !== 'running') return
      }
    }
    step.status = 'running'
    step.startedAt = new Date().toISOString()
    const job = demoJob(step.target, step.targetType, step.fun, step.arg, step.kwarg, run.startedBy)
    if (!job) {
      Object.assign(step, { status: 'failed', error: 'No minion matched the target', finishedAt: new Date().toISOString() })
      if (step.onFailure) continue
      const error = `${step.name}: No minion matched the target`
      if (toFailureSteps(run, error)) i = run.cursor - 1
      else return end(run, 'failed', error)
      continue
    }
    Object.assign(step, { jid: job.jid, minions: job.minions })
    const until = Date.now() + STEP_WAIT_MS
    let p = demoJobProgress(job.jid)
    while (p.returned.length < job.minions.length && Date.now() < until) {
      await sleep(400)
      if (run.status !== 'running') return
      p = demoJobProgress(job.jid)
    }
    const missing = job.minions.filter((m) => !p.returned.includes(m))
    const failed = [...p.failed].sort()
    const bad = failed.length + missing.length
    Object.assign(step, { status: bad ? 'failed' : 'done', ok: p.returned.length - failed.length, failed, missing, finishedAt: new Date().toISOString() })
    if (bad && !step.continueOnFailure && !step.onFailure) {
      const who = [...failed, ...missing]
      const error = `${step.name} failed on ${who.length} ${who.length === 1 ? 'minion' : 'minions'}: ${who.join(', ')}`
      if (toFailureSteps(run, error)) i = run.cursor - 1
      else return end(run, 'stopped', error)
    }
  }
  if (run.status !== 'running') return
  if (!run.error) return end(run, 'done', null)
  // its steps for a failure have run; it ends as the step that stopped it
  const first = run.steps.find((s) => !s.onFailure && s.status === 'failed' && (!s.continueOnFailure || !s.jid))
  end(run, first && !first.jid ? 'failed' : 'stopped', run.error)
}

/** A step stopped the run: on to its steps for a failure, holding the error, if it has any. */
function toFailureSteps(run: RunbookRun, error: string) {
  const at = run.steps.findIndex((s) => s.onFailure && s.status === 'waiting')
  if (at < 0) return false
  for (const s of run.steps) if (!s.onFailure && s.status === 'waiting') s.status = 'skipped'
  Object.assign(run, { error, cursor: at })
  return true
}

function end(run: RunbookRun, status: 'done' | 'stopped' | 'failed', error: string | null) {
  for (const s of run.steps) if (s.status === 'waiting' || s.status === 'paused') s.status = 'skipped'
  Object.assign(run, { status, error, finishedAt: new Date().toISOString() })
}

function start(rb: Runbook, params: Record<string, string>, by = 'demo') {
  const r = resolveRunbook(rb, params)
  if ('error' in r) return r
  const run: RunbookRun = {
    id: nextRun++,
    runbookId: rb.id,
    name: rb.name,
    params: r.values,
    steps: r.steps.map((s): RunbookStepState => ({ ...s, status: 'waiting' })),
    cursor: 0,
    status: 'running',
    startedBy: by,
    startedById: by,
    decidedBy: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  }
  runs.unshift(run)
  void work(run)
  return { run }
}

// an earlier run, for the history: Olga restarted nginx on web-01
start(list[0], { host: 'web-01' }, 'olga')

const live = (r: RunbookRun) => r.status === 'running' || r.status === 'pending'

/** The demo's schedules say which of them runs a runbook, so a runbook in use isn't deleted. */
let usedBy: (runbookId: number) => string | null = () => null
export const setDemoRunbookUsers = (fn: typeof usedBy) => void (usedBy = fn)

export const demoRunbookName = (id: number) => list.find((x) => x.id === id)?.name ?? null

/** Whether a schedule could run it with these values: null, or why not. */
export function demoRunbookCheck(id: number, params: Record<string, string>) {
  const rb = list.find((x) => x.id === id)
  if (!rb) return 'Choose a runbook'
  const r = resolveRunbook(rb, params)
  return 'error' in r ? r.error : null
}

/** A schedule's run, started as the schedule, unless its last one is still going. */
export function demoScheduledRun(id: number, params: Record<string, string>, by: string): { run: number } | { error: string } {
  const rb = list.find((x) => x.id === id)
  if (!rb) return { error: 'Its runbook no longer exists' }
  const going = runs.find((r) => r.startedBy === by && live(r))
  if (going) return { error: `Its last run, #${going.id}, hasn't finished` }
  const r = start(rb, params, by)
  return 'error' in r ? { error: r.error } : { run: r.run.id }
}

/** The runs a schedule started, newest first. */
export const demoRunsBy = (by: string) => runs.filter((r) => r.startedBy === by).map(copy)

export const demoRunbooks: typeof runbooks = {
  list: () => delay({ runbooks: list.map((rb) => ({ ...rb })).sort((a, b) => a.name.localeCompare(b.name)), approval: 'off' as const }),
  save: (input, id) => {
    const rb = readRunbook(input as unknown as Record<string, unknown>)
    if ('error' in rb) return fail(rb.error)
    if (list.some((x) => x.name === rb.name && x.id !== id)) return fail('A runbook with this name already exists')
    const existing = id ? list.find((x) => x.id === id) : undefined
    if (id && !existing) return fail('Not found')
    const row: Runbook = { ...rb, id: existing?.id ?? nextId++, createdBy: existing?.createdBy ?? 'demo', updatedAt: new Date().toISOString() }
    if (existing) Object.assign(existing, row)
    else list.push(row)
    recordDemoAudit({ username: 'demo', client: 'admin', fun: existing ? 'runbook.update' : 'runbook.create', target: rb.name, outcome: 'ok' })
    return delay({ runbook: { ...row } })
  },
  import: (input, replace) => {
    const read: RunbookInput[] = []
    for (const [i, item] of input.entries()) {
      const rb = readRunbook(item as unknown as Record<string, unknown>)
      if ('error' in rb) return fail(`Runbook ${i + 1}: ${rb.error}`)
      if (read.some((x) => x.name === rb.name)) return fail(`"${rb.name}" is there twice`)
      read.push(rb)
    }
    const taken = read.filter((rb) => list.some((x) => x.name === rb.name)).map((rb) => rb.name)
    if (taken.length && !replace) return fail(`These already exist: ${taken.join(', ')}. Replace them, or rename them in the file`)
    let created = 0
    for (const rb of read) {
      const existing = list.find((x) => x.name === rb.name)
      if (existing) Object.assign(existing, rb, { updatedAt: new Date().toISOString() })
      else {
        list.push({ ...rb, id: nextId++, createdBy: 'demo', updatedAt: new Date().toISOString() })
        created++
      }
      recordDemoAudit({ username: 'demo', client: 'admin', fun: 'runbook.import', target: rb.name, outcome: 'ok' })
    }
    return delay({ created, replaced: read.length - created })
  },
  remove: (id) => {
    const schedule = usedBy(id)
    if (schedule) return fail(`The schedule "${schedule}" runs it; delete that schedule or pick another runbook for it first`)
    const hook = hooks.find((h) => h.runbookId === id)
    if (hook) return fail(`The webhook "${hook.name}" runs it; delete that webhook first`)
    const i = list.findIndex((x) => x.id === id)
    if (i >= 0) {
      recordDemoAudit({ username: 'demo', client: 'admin', fun: 'runbook.delete', target: list[i].name, outcome: 'ok' })
      list.splice(i, 1)
    }
    return delay({})
  },
  run: (id, params) => {
    const rb = list.find((x) => x.id === id)
    if (!rb) return fail('Not found')
    const r = start(rb, params)
    if ('error' in r) return fail(r.error)
    recordDemoAudit({ username: 'demo', client: 'console', fun: 'runbook.run', target: `#${r.run.id} ${rb.name}`, args: JSON.stringify(r.run.params), outcome: 'ok' })
    return delay({ run: copy(r.run) })
  },
  runs: (runbookId) => delay({ runs: runs.filter((r) => !runbookId || r.runbookId === runbookId).map(copy) }),
  getRun: (id) => {
    const r = runs.find((x) => x.id === id)
    return r ? delay({ run: copy(r) }) : fail('Not found')
  },
  act: (id, verb) => {
    const r = runs.find((x) => x.id === id)
    if (!r) return fail('Not found')
    if (verb !== 'stop') return fail("It isn't waiting for approval")
    if (r.status !== 'running' && r.status !== 'pending') return fail('It has already finished')
    end(r, 'stopped', 'Stopped by demo')
    recordDemoAudit({ username: 'demo', client: 'console', fun: 'runbook.stop', target: `#${r.id} ${r.name}`, outcome: 'ok' })
    return delay({ run: copy(r) })
  },
  proceed: (id) => {
    const r = runs.find((x) => x.id === id)
    if (!r) return fail('Not found')
    const step = r.steps[r.cursor]
    if (r.status !== 'running' || step?.status !== 'paused') return fail("It isn't waiting to go on")
    Object.assign(step, { status: 'waiting', confirmedBy: 'demo' })
    recordDemoAudit({ username: 'demo', client: 'console', fun: 'runbook.proceed', target: `#${r.id} ${r.name}`, args: JSON.stringify({ step: r.cursor + 1, name: step.name }), outcome: 'ok' })
    return delay({ run: copy(r) })
  },
  continue: (id) => {
    const prev = runs.find((x) => x.id === id)
    if (!prev) return fail('Not found')
    const at = continueFrom(prev)
    if (at === null) return fail(prev.status === 'stopped' || prev.status === 'failed' ? 'Every step has run; run it again instead' : 'Only a stopped or failed run can be continued')
    const run: RunbookRun = { ...prev, id: nextRun++, steps: continuedSteps(prev.steps, at, prev.id), cursor: at, status: 'running', startedBy: 'demo', startedById: 'demo', decidedBy: null, startedAt: new Date().toISOString(), finishedAt: null, error: null }
    runs.unshift(run)
    void work(run)
    recordDemoAudit({ username: 'demo', client: 'console', fun: 'runbook.continue', target: `#${run.id} ${run.name}`, args: JSON.stringify({ from: prev.id, step: at + 1 }), outcome: 'ok' })
    return delay({ run: copy(run) })
  },
}

// ---- webhooks that start a runbook: one to try; the demo can't be called from outside ----

const demoHookSecret = () => `whk_${Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('')}`

let nextHook = 1
const hooks: RunbookHook[] = [
  {
    id: nextHook++,
    name: 'Alertmanager: nginx down',
    runbookId: 1,
    params: { service: 'nginx' },
    fromRequest: ['host'],
    enabled: true,
    createdBy: 'pam',
    createdAt: new Date(Date.now() - 4 * 86400_000).toISOString(),
    lastCalledAt: null,
    lastRunId: null,
    lastError: null,
  },
]

function readHook(input: Partial<RunbookHook>, id?: number) {
  const name = input.name?.trim() ?? ''
  if (!name || name.length > 80) return { error: 'Name is required (max 80 characters)' }
  if (hooks.some((h) => h.name === name && h.id !== id)) return { error: 'A webhook with this name already exists' }
  const rb = list.find((x) => x.id === input.runbookId)
  if (!rb) return { error: 'Choose a runbook' }
  const settings = readHookSettings(rb.params, input.params, input.fromRequest)
  return 'error' in settings ? settings : { name, runbookId: rb.id, ...settings }
}

export const demoRunbookHooks: typeof runbookHooks = {
  list: () => delay({ hooks: hooks.map((h) => ({ ...h })) }),
  create: (input) => {
    const h = readHook(input)
    if ('error' in h) return fail(h.error)
    const row: RunbookHook = { ...h, id: nextHook++, enabled: true, createdBy: 'demo', createdAt: new Date().toISOString(), lastCalledAt: null, lastRunId: null, lastError: null }
    hooks.push(row)
    hooks.sort((a, b) => a.name.localeCompare(b.name))
    recordDemoAudit({ username: 'demo', client: 'admin', fun: 'runbook_hook.create', target: row.name, outcome: 'ok' })
    return delay({ hook: { ...row }, secret: demoHookSecret() })
  },
  update: (id, changes) => {
    const h = hooks.find((x) => x.id === id)
    if (!h) return fail('Not found')
    if (!(Object.keys(changes).length === 1 && 'enabled' in changes)) {
      const read = readHook({ ...h, ...changes }, id)
      if ('error' in read) return fail(read.error)
      Object.assign(h, read)
    }
    if (typeof changes.enabled === 'boolean') h.enabled = changes.enabled
    recordDemoAudit({ username: 'demo', client: 'admin', fun: 'runbook_hook.update', target: h.name, args: JSON.stringify(changes), outcome: 'ok' })
    return delay({ hook: { ...h } })
  },
  remove: (id) => {
    const i = hooks.findIndex((x) => x.id === id)
    if (i >= 0) {
      recordDemoAudit({ username: 'demo', client: 'admin', fun: 'runbook_hook.delete', target: hooks[i].name, outcome: 'ok' })
      hooks.splice(i, 1)
    }
    return delay(undefined)
  },
  rotate: (id) => (hooks.some((x) => x.id === id) ? delay({ secret: demoHookSecret() }) : fail('Not found')),
  // as the server's endpoint answers a call, without checking a secret
  test: (id, body) => {
    const h = hooks.find((x) => x.id === id)
    if (!h) return fail('Not found')
    if (!h.enabled) return fail('This webhook is turned off')
    const read = readCallValues(body, h.fromRequest)
    if ('error' in read) return fail(read.error)
    const by = `hook:${h.name}`
    const done = (error: string) => {
      Object.assign(h, { lastCalledAt: new Date().toISOString(), lastError: error })
      return fail(error)
    }
    const rb = list.find((x) => x.id === h.runbookId)
    if (!rb) return done('Its runbook no longer exists')
    const going = runs.find((r) => r.startedBy === by && live(r))
    if (going) return done(`Its last run, #${going.id}, hasn't finished`)
    const r = start(rb, { ...h.params, ...read.values }, by)
    if ('error' in r) return done(r.error)
    Object.assign(h, { lastCalledAt: new Date().toISOString(), lastRunId: r.run.id, lastError: null })
    recordDemoAudit({ username: by, client: 'console', fun: 'runbook.run', target: `#${r.run.id} ${rb.name}`, args: JSON.stringify(r.run.params), outcome: 'ok' })
    return delay<HookCall>({ run: r.run.id, status: r.run.status, path: `/runbooks/runs/${r.run.id}` })
  },
}
