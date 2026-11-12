import { recordDemoAudit } from './demo-audit'
import { demoJob, demoJobProgress, demoMatch } from './mock'
import type { Change, ChangeInput, MinionOutcome, changes } from './server'

/*
 * Changes in the demo: approvals by policy (the demo asks for them, like APPROVAL_REQUIRED=risky),
 * batches run on the simulated master one after another, and a stop when too many minions fail.
 * Kept in the browser; the demo user is an admin, and Olga, an operator, has a change waiting.
 */

const delay = <T>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 120))
const fail = (m: string) => Promise.reject(new Error(m))
const DEADLINE_MS = 60_000
const RISKY = /^(cmd\.|state\.(apply|highstate|sls)$|pkg\.(install|remove|upgrade)$|service\.(restart|stop)$|system\.reboot$)/

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
let nextId = 1
const list: Change[] = []

function add(c: Omit<Change, 'id'>) {
  const row = { ...c, id: nextId++ }
  list.unshift(row)
  return row
}

// an earlier rollout, done
{
  const minions = demoMatch('web-*', 'glob')
  const batches = minions.map((m, i) => ({ jid: demoJob(m, 'list', 'state.apply', ['webserver'], {}, 'olga', new Date(Date.now() - (120 - i * 3) * 60_000), true)?.jid ?? null, minions: [m], startedAt: ago(120 - i * 3) }))
  add({ reason: 'New nginx site config, one web server at a time', target: 'web-*', targetType: 'glob', fun: 'state.apply', args: { arg: ['webserver'], kwarg: {} }, batchSize: '1', maxFailures: 0, status: 'done', requestedBy: 'olga', requestedById: 'u2', requestedAt: ago(130), decidedBy: 'pam', decidedAt: ago(125), decisionNote: 'Go ahead', minions, batches, startedAt: ago(120), finishedAt: ago(110), error: null })
}
// one waiting for approval
add({ reason: 'Patch openssl on the database servers (DEMO-2026-0101)', target: 'db-*', targetType: 'glob', fun: 'pkg.install', args: { arg: [], kwarg: { pkgs: ['openssl', 'libssl3'], only_upgrade: true } }, batchSize: '1', maxFailures: 0, status: 'pending', requestedBy: 'olga', requestedById: 'u2', requestedAt: ago(14), decidedBy: null, decidedAt: null, decisionNote: null, minions: null, batches: [], startedAt: null, finishedAt: null, error: null })
// last night's compliance check found web-02 drifted, and its schedule fixed it
export const demoRemedyChange = (() => {
  const at = new Date()
  at.setHours(2, 6, 0, 0)
  if (+at > Date.now()) at.setDate(at.getDate() - 1)
  const iso = (d: Date) => d.toISOString()
  const job = demoJob('web-02', 'list', 'state.apply', [], {}, 'schedule:Nightly compliance', at, true)
  return add({
    reason: 'Fix the drift that "Nightly compliance" found',
    target: 'web-02',
    targetType: 'list',
    fun: 'state.apply',
    args: { arg: [], kwarg: {} },
    batchSize: '50%',
    maxFailures: 1,
    status: 'done',
    requestedBy: 'schedule:Nightly compliance',
    requestedById: null,
    requestedAt: iso(at),
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    minions: ['web-02'],
    batches: [{ jid: job?.jid ?? null, minions: ['web-02'], startedAt: iso(at) }],
    startedAt: iso(at),
    finishedAt: iso(new Date(+at + 3 * 60_000)),
    error: null,
  }).id
})()

const find = (id: number) => list.find((c) => c.id === id)

/** Moves running changes along: next batch when the last one is in, stop on too many failures. */
function step() {
  for (const c of list) {
    if (c.status === 'queued') {
      const minions = demoMatch(c.target, c.targetType)
      c.status = minions.length ? 'running' : 'failed'
      c.startedAt = new Date().toISOString()
      c.minions = minions
      if (!minions.length) {
        c.error = 'The target matches no minions'
        c.finishedAt = c.startedAt
      }
      continue
    }
    if (c.status !== 'running' || !c.minions) continue
    const last = c.batches[c.batches.length - 1]
    const failed: string[] = []
    let lastDone = true
    for (const b of c.batches) {
      const p = b.jid ? demoJobProgress(b.jid) : { returned: [] as string[], failed: [] as string[] }
      const over = p.returned.length >= b.minions.length || Date.now() - Date.parse(b.startedAt) > DEADLINE_MS
      if (b === last) lastDone = over
      failed.push(...p.failed, ...(over ? b.minions.filter((m) => !p.returned.includes(m)) : []))
    }
    if (last && !lastDone) continue
    if (failed.length > c.maxFailures) {
      Object.assign(c, { status: 'stopped', finishedAt: new Date().toISOString(), error: `${failed.length} ${failed.length === 1 ? 'minion' : 'minions'} failed (${failed.join(', ')}); at most ${c.maxFailures} allowed` })
      continue
    }
    const started = c.batches.reduce((n, b) => n + b.minions.length, 0)
    const size = batchSize(c.batchSize, c.minions.length)
    const next = c.minions.slice(started, started + size)
    if (!next.length) {
      Object.assign(c, { status: 'done', finishedAt: new Date().toISOString() })
      continue
    }
    const job = demoJob(next.join(','), 'list', c.fun, c.args.arg, c.args.kwarg, c.requestedBy)
    c.batches.push({ jid: job?.jid ?? null, minions: next, startedAt: new Date().toISOString() })
  }
}
setInterval(step, 1000)

function batchSize(s: string | null, total: number) {
  const v = (s ?? '').trim()
  if (!v) return total
  const pct = /^(\d+(?:\.\d+)?)%$/.exec(v)
  return Math.max(1, Math.min(total, pct ? Math.ceil((total * Number(pct[1])) / 100) : Math.floor(Number(v)) || total))
}

function outcome(c: Change): Record<string, MinionOutcome> {
  const o: Record<string, MinionOutcome> = {}
  for (const m of c.minions ?? []) o[m] = 'waiting'
  for (const b of c.batches) {
    const p = b.jid ? demoJobProgress(b.jid) : { returned: [] as string[], failed: [] as string[] }
    for (const m of b.minions) o[m] = p.failed.includes(m) ? 'failed' : p.returned.includes(m) ? 'ok' : 'running'
  }
  return o
}

const audit = (fun: string, c: Change, args?: object) => recordDemoAudit({ username: 'demo', client: 'console', fun, target: `#${c.id} ${c.fun} → ${c.target}`, args: args ? JSON.stringify(args) : null, outcome: 'ok' })

export const demoChanges: typeof changes = {
  // newest first, like the server (the seeded ones aren't added in time order)
  list: () => delay({ changes: [...list].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)).map((c) => ({ ...c, batches: [...c.batches] })), approval: 'risky' as const }),
  get: (id: number) => {
    const c = find(id)
    return c ? delay({ change: { ...c, batches: [...c.batches] }, outcome: outcome(c) }) : fail('Not found')
  },
  create: (i: ChangeInput) => {
    if (!i.reason.trim()) return fail('Say what the change is for')
    // the demo user is an admin: nothing of theirs waits for approval
    const c = add({ ...i, args: { arg: i.arg, kwarg: i.kwarg }, batchSize: i.batchSize || null, status: 'queued', requestedBy: 'demo', requestedById: 'demo', requestedAt: new Date().toISOString(), decidedBy: null, decidedAt: null, decisionNote: null, minions: null, batches: [], startedAt: null, finishedAt: null, error: null })
    audit('change.request', c, { reason: i.reason, batchSize: i.batchSize, maxFailures: i.maxFailures })
    step()
    return delay({ change: c })
  },
  approve: (id: number, note?: string) => {
    const c = find(id)
    if (!c || c.status !== 'pending') return fail("It isn't waiting for approval")
    Object.assign(c, { status: 'queued', decidedBy: 'demo', decidedAt: new Date().toISOString(), decisionNote: note || null })
    audit('change.approve', c, note ? { note } : undefined)
    step()
    return delay({})
  },
  reject: (id: number, note: string) => {
    const c = find(id)
    if (!c || c.status !== 'pending') return fail("It isn't waiting for approval")
    if (!note.trim()) return fail('Say why it is rejected')
    Object.assign(c, { status: 'rejected', decidedBy: 'demo', decidedAt: new Date().toISOString(), decisionNote: note })
    audit('change.reject', c, { note })
    return delay({})
  },
  stop: (id: number) => {
    const c = find(id)
    if (!c || !['pending', 'queued', 'running'].includes(c.status)) return fail("It isn't running")
    Object.assign(c, { status: 'stopped', finishedAt: new Date().toISOString(), error: 'Stopped by demo' })
    audit('change.stop', c)
    return delay({})
  },
}

/** Whether the demo's policy wants approval for this call (it does for what changes minions, from operators). */
export const demoNeedsApproval = (fun: string) => RISKY.test(fun)
