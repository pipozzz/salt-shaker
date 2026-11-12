import { readRunbook, resolveRunbook, type RunbookInput } from '../lib/runbook'
import { recordDemoAudit } from './demo-audit'
import { demoJob, demoJobProgress } from './mock'
import type { Runbook, RunbookRun, RunbookStepState, runbooks } from './server'

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
    description: 'Checks the configuration first, restarts the service only if it is valid, then makes sure it runs.',
    params: [
      { name: 'host', label: 'Minions', default: 'web-01', required: true },
      { name: 'service', label: 'Service', default: 'nginx', required: true },
    ],
    steps: [
      { name: 'Check the configuration', fun: 'cmd.run', target: '{{host}}', targetType: 'glob', args: "'{{service}} -t'", continueOnFailure: false },
      { name: 'Restart', fun: 'service.restart', target: '{{host}}', targetType: 'glob', args: '{{service}}', continueOnFailure: false },
      { name: 'Make sure it runs', fun: 'service.status', target: '{{host}}', targetType: 'glob', args: '{{service}}', continueOnFailure: false },
    ],
  },
  {
    name: 'Sync and apply the highstate',
    description: 'Syncs custom modules, shows what the highstate would change, then applies it.',
    params: [{ name: 'target', label: 'Minions', default: 'web-*', required: true }],
    steps: [
      { name: 'Sync modules', fun: 'saltutil.sync_all', target: '{{target}}', targetType: 'glob', args: '', continueOnFailure: false },
      { name: 'Dry run', fun: 'state.apply', target: '{{target}}', targetType: 'glob', args: 'test=True', continueOnFailure: true },
      { name: 'Apply', fun: 'state.apply', target: '{{target}}', targetType: 'glob', args: '', continueOnFailure: false },
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
  for (let i = 0; i < run.steps.length; i++) {
    if (run.status !== 'running') return
    run.cursor = i
    const step = run.steps[i]
    step.status = 'running'
    step.startedAt = new Date().toISOString()
    const job = demoJob(step.target, step.targetType, step.fun, step.arg, step.kwarg, run.startedBy)
    if (!job) {
      Object.assign(step, { status: 'failed', error: 'No minion matched the target', finishedAt: new Date().toISOString() })
      return end(run, 'failed', `${step.name}: No minion matched the target`)
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
    if (bad && !step.continueOnFailure) {
      const who = [...failed, ...missing]
      return end(run, 'stopped', `${step.name} failed on ${who.length} ${who.length === 1 ? 'minion' : 'minions'}: ${who.join(', ')}`)
    }
  }
  end(run, 'done', null)
}

function end(run: RunbookRun, status: 'done' | 'stopped' | 'failed', error: string | null) {
  for (const s of run.steps) if (s.status === 'waiting') s.status = 'skipped'
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
  remove: (id) => {
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
}
