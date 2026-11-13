import { batchCount } from '../lib/batch'
import { continuedSteps, continueFrom, readRunbook, resolveRunbook, type RunbookInput } from '../lib/runbook'
import { readCallValues, readHookSettings } from '../lib/runbook-hook'
import { recordDemoAudit } from './demo-audit'
import { demoJob, demoJobProgress, demoMatch } from './mock'
import type { HookCall, Runbook, RunbookHook, RunbookRun, RunbookStepState, RunbookVersion, runbookHooks, runbooks } from './server'

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
const list: Runbook[] = SEED.map((rb) => ({ ...rb, id: nextId++, version: 1, createdBy: 'pam', updatedAt: new Date(Date.now() - 6 * 86400_000).toISOString() }))

// every saved version, like the server's runbook_version
let nextVersionId = 1
const versions: RunbookVersion[] = list.map((rb) => ({ ...content(rb), id: nextVersionId++, runbookId: rb.id, version: 1, how: 'create', savedBy: 'pam', savedAt: rb.updatedAt }))
// the restart was written without its step for a failure, which pam added later and gave to olga
{
  const first = versions[0]
  Object.assign(first, { steps: first.steps.filter((x) => !x.onFailure), runners: [], savedAt: new Date(Date.now() - 9 * 86400_000).toISOString() })
  versions.push({ ...content(list[0]), id: nextVersionId++, runbookId: list[0].id, version: 2, how: 'update', savedBy: 'pam', savedAt: list[0].updatedAt })
  list[0].version = 2
}

function content(rb: RunbookInput): RunbookInput {
  return { name: rb.name, description: rb.description, params: rb.params.map((p) => ({ ...p })), steps: rb.steps.map((s) => ({ ...s })), runners: [...(rb.runners ?? [])] }
}
const sameContent = (a: RunbookInput, b: RunbookInput) => JSON.stringify(content(a)) === JSON.stringify(content(b))

/** Saves a runbook as its next version (or its first), unless nothing changed, like the server. */
function saveVersion(existing: Runbook | undefined, rb: RunbookInput, how: RunbookVersion['how']): { row: Runbook; changed: boolean } {
  if (existing && sameContent(existing, rb)) return { row: existing, changed: false }
  const now = new Date().toISOString()
  let row: Runbook
  if (existing) row = Object.assign(existing, content(rb), { version: existing.version + 1, updatedAt: now })
  else list.push((row = { ...content(rb), id: nextId++, version: 1, createdBy: 'demo', updatedAt: now }))
  versions.push({ ...content(rb), id: nextVersionId++, runbookId: row.id, version: row.version, how, savedBy: 'demo', savedAt: now })
  return { row, changed: true }
}
let nextRun = 1
const runs: RunbookRun[] = []
const copy = (r: RunbookRun): RunbookRun => ({ ...r, steps: r.steps.map((s) => ({ ...s })) })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Starts a job and waits for its minions, for up to the step's wait; null when nothing matched. */
async function runJob(run: RunbookRun, tgt: string, tgtType: string, step: RunbookStepState) {
  const job = demoJob(tgt, tgtType, step.fun, step.arg, step.kwarg, run.startedBy)
  if (!job) return null
  step.jid = job.jid
  if (!step.batchSize) step.minions = job.minions
  const until = Date.now() + STEP_WAIT_MS
  let p = demoJobProgress(job.jid)
  while (p.returned.length < job.minions.length && Date.now() < until) {
    await sleep(400)
    if (run.status !== 'running') return 'stopped' as const
    p = demoJobProgress(job.jid)
  }
  return { jid: job.jid, minions: job.minions, returned: p.returned, failed: [...p.failed].sort(), missing: job.minions.filter((m) => !p.returned.includes(m)) }
}

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
    /** The step failed: on to the steps for a failure, or the run ends; false to go on. */
    const stop = (status: 'stopped' | 'failed', error: string) => {
      if (step.onFailure) return false
      if (toFailureSteps(run, error)) {
        i = run.cursor - 1
        return false
      }
      end(run, status, error)
      return true
    }

    let ok = 0
    const failed: string[] = []
    const missing: string[] = []
    let notStarted: string[] = []
    let batchNote = ''
    if (step.batchSize) {
      // the minions first, then a batch at a time, stopping at the first batch with a failure
      const all = [...demoMatch(step.target, step.targetType)].sort()
      if (!all.length) {
        Object.assign(step, { status: 'failed', error: 'No minion matched the target', finishedAt: new Date().toISOString() })
        if (stop('failed', `${step.name}: No minion matched the target`)) return
        continue
      }
      Object.assign(step, { minions: all, batches: [] })
      let rest = all
      while (rest.length) {
        const next = rest.slice(0, batchCount(step.batchSize, all.length))
        rest = rest.slice(next.length)
        step.batches!.push({ jid: null, minions: next, startedAt: new Date().toISOString() })
        const r = await runJob(run, next.join(','), 'list', step)
        if (r === 'stopped') return
        if (r) step.batches!.at(-1)!.jid = r.jid
        const got = r ?? { returned: [], failed: [], missing: next }
        ok += got.returned.length - got.failed.length
        failed.push(...got.failed)
        missing.push(...got.missing)
        if (got.failed.length + got.missing.length) {
          notStarted = rest
          batchNote = ` in batch ${step.batches!.length}`
          break
        }
      }
    } else {
      const r = await runJob(run, step.target, step.targetType, step)
      if (r === 'stopped') return
      if (!r) {
        Object.assign(step, { status: 'failed', error: 'No minion matched the target', finishedAt: new Date().toISOString() })
        if (stop('failed', `${step.name}: No minion matched the target`)) return
        continue
      }
      step.minions = r.minions
      ok = r.returned.length - r.failed.length
      failed.push(...r.failed)
      missing.push(...r.missing)
    }
    const bad = failed.length + missing.length
    Object.assign(step, { status: bad ? 'failed' : 'done', ok, failed: failed.sort(), missing: missing.sort(), ...(notStarted.length ? { notStarted } : {}), finishedAt: new Date().toISOString() })
    if (bad && !step.continueOnFailure && !step.onFailure) {
      const who = [...failed, ...missing]
      const skipped = notStarted.length ? `; ${notStarted.length} not started` : ''
      if (stop('stopped', `${step.name} failed on ${who.length} ${who.length === 1 ? 'minion' : 'minions'}${batchNote}: ${who.join(', ')}${skipped}`)) return
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
    runbookVersion: rb.version,
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
    const { row, changed } = saveVersion(existing, rb, existing ? 'update' : 'create')
    if (changed) recordDemoAudit({ username: 'demo', client: 'admin', fun: existing ? 'runbook.update' : 'runbook.create', target: rb.name, outcome: 'ok' })
    return delay({ runbook: { ...row } })
  },
  versions: (id) => (list.some((x) => x.id === id) ? delay({ versions: versions.filter((v) => v.runbookId === id).sort((a, b) => b.version - a.version).map((v) => ({ ...v, ...content(v) })) }) : fail('Not found')),
  restore: (id, version) => {
    const rb = list.find((x) => x.id === id)
    const v = versions.find((x) => x.runbookId === id && x.version === version)
    if (!rb) return fail('Not found')
    if (!v) return fail('There is no such version')
    if (list.some((x) => x.name === v.name && x.id !== id)) return fail(`Another runbook is called "${v.name}" now; rename it first`)
    const { row, changed } = saveVersion(rb, v, 'restore')
    if (!changed) return fail('It is already like that version')
    recordDemoAudit({ username: 'demo', client: 'admin', fun: 'runbook.restore', target: rb.name, args: JSON.stringify({ from: version, version: row.version }), outcome: 'ok' })
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
      if (!existing) created++
      if (!saveVersion(existing, rb, 'import').changed) continue
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
      for (let j = versions.length - 1; j >= 0; j--) if (versions[j].runbookId === id) versions.splice(j, 1)
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
