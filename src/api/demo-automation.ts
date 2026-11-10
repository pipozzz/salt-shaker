import { Cron } from 'croner'
import { checkQuery, OSQUERY_LIBRARY } from '../lib/osquery'
import type { automation, AutomationMeta, Channel, NotifyEvent, Schedule, ScheduleInput, ScheduleKind, ScheduleRun } from './server'

/*
 * Schedules and notification channels in the demo: kept in memory (they're gone on reload), with a
 * few made up to start from. Nothing is sent and nothing runs on a schedule; "Run now" records a run.
 */

const KINDS: Record<ScheduleKind, string> = {
  compliance: 'Compliance check (state.apply test=True)',
  patches: 'Patch scan (pkg.list_upgrades)',
  vulns: 'Vulnerability scan (package inventory)',
  osquery: 'osquery query (alert on changes)',
  function: 'Any function',
}

const EVENTS: Record<NotifyEvent, string> = {
  drift: 'A scheduled compliance check found drift or errors',
  patches: 'A scheduled patch scan found upgrades',
  vulns: 'A scheduled vulnerability scan found critical or high vulnerabilities with a fix',
  osquery: "A scheduled osquery query's results changed since its last run",
  schedule: 'Any scheduled run finished',
  job_failed: 'A job failed on any minion',
  pending_key: 'A new minion is waiting for key approval',
  minion_down: 'A minion stopped responding, or is back',
}

const delay = <T>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 120))
const fail = (message: string) => Promise.reject(new Error(message))
const jidAt = (d: Date) => d.toISOString().replace(/\D/g, '').slice(0, 14) + String(d.getMilliseconds()).padStart(3, '0') + '000'

const next = (cron: string, from = new Date()) => new Cron(cron, { paused: true }).nextRun(from)

/** the last ten runs, one per cron slot before now */
function history(cron: string, status: (i: number) => ScheduleRun['status'], detail: (i: number) => string): ScheduleRun[] {
  const c = new Cron(cron, { paused: true })
  const slots: Date[] = []
  const t = new Date(Date.now() - 40 * 86400_000)
  for (let d = c.nextRun(t); d && d < new Date(); d = c.nextRun(d)) slots.push(d)
  return slots.slice(-10).map((d, i) => ({ jid: jidAt(d), startedAt: d.toISOString(), status: status(i), detail: detail(i) }))
}

let id = 0
const now = Date.now()
const schedules: Array<Omit<Schedule, 'nextRunAt' | 'cronError'>> = []
function seed(s: Omit<Schedule, 'id' | 'nextRunAt' | 'cronError' | 'createdBy' | 'lastRunAt' | 'lastJid' | 'enabled'> & { enabled?: boolean }) {
  const last = s.recentRuns[s.recentRuns.length - 1]
  schedules.push({ enabled: true, ...s, id: ++id, createdBy: 'demo', lastRunAt: last?.startedAt ?? null, lastJid: last?.jid ?? null })
}
seed({
  name: 'Nightly compliance',
  kind: 'compliance',
  fun: null,
  args: null,
  target: '*',
  targetType: 'glob',
  cron: '0 2 * * *',
  lastSummary: { ok: 4, drift: 1, error: 0, noreturn: 1 },
  recentRuns: history('0 2 * * *', (i) => (i === 6 ? 'failed' : i > 7 ? 'changed' : 'ok'), (i) => (i > 7 ? '4 ok · 1 drifted · 0 errors · 1 no return' : i === 6 ? '4 ok · 0 drifted · 1 error' : '5 ok · 0 drifted · 0 errors')),
})
seed({
  name: 'Weekly patch scan',
  kind: 'patches',
  fun: null,
  args: null,
  target: '*',
  targetType: 'glob',
  cron: '0 6 * * 1',
  lastSummary: { needUpdates: 5, packages: 6, scanned: 5 },
  recentRuns: history('0 6 * * 1', () => 'changed', () => '5 minions with 6 packages to update'),
})
seed({
  name: 'Vulnerability scan',
  kind: 'vulns',
  fun: null,
  args: null,
  target: '*',
  targetType: 'glob',
  cron: '30 3 * * *',
  lastSummary: { scanned: 6, notCovered: 0, affected: 6, critical: 1, high: 2, fixable: 6, noreturn: 0 },
  recentRuns: history('30 3 * * *', () => 'ok', () => '6 ok · 0 failed'),
})
seed({
  name: 'Watch SSH keys',
  kind: 'osquery',
  fun: null,
  args: { sql: OSQUERY_LIBRARY.find((q) => q.name === 'Authorized SSH keys')!.sql },
  target: 'web-*',
  targetType: 'glob',
  cron: '0 * * * *',
  lastSummary: { baseline: false, minions: 2, rows: 3, added: 1, removed: 0, changedMinions: 1, missing: 0, failed: 0, tooLarge: 0, noreturn: 0, examples: [] },
  recentRuns: history('0 * * * *', () => 'ok', () => '2 ok · 0 failed'),
})

const channels: Channel[] = [
  { id: 1, name: 'Ops Slack', kind: 'slack', url: 'https://hooks.slack.com/…7Qx2', events: ['drift', 'vulns', 'osquery', 'job_failed'], enabled: true, lastSentAt: new Date(now - 3 * 3600_000).toISOString(), lastError: null },
  { id: 2, name: 'Incident webhook', kind: 'webhook', url: 'https://alerts.example.com/…ook', events: ['minion_down'], enabled: false, lastSentAt: null, lastError: null },
]

function view(s: (typeof schedules)[number]): Schedule {
  try {
    return { ...s, nextRunAt: s.enabled ? (next(s.cron)?.toISOString() ?? null) : null, cronError: null }
  } catch (e) {
    return { ...s, nextRunAt: null, cronError: e instanceof Error ? e.message : String(e) }
  }
}

/** The same checks as the server's, so the demo's form behaves the same. */
function check(s: Partial<ScheduleInput>, current?: { id: number }) {
  if (!s.name?.trim()) return 'Name is required'
  if (schedules.some((x) => x.name === s.name!.trim() && x.id !== current?.id)) return 'A schedule with this name already exists'
  if (!s.target?.trim()) return 'Target is required'
  try {
    if (!next(s.cron ?? '')) return `Invalid schedule "${s.cron}": never runs`
  } catch (e) {
    return `Invalid schedule "${s.cron}": ${e instanceof Error ? e.message : e}`
  }
  if (s.kind === 'function' && !s.fun) return 'Function is required'
  if (s.kind === 'osquery') return checkQuery((s.args as { sql?: string } | null)?.sql ?? '')
  return null
}

export const demoAutomation: typeof automation = {
  meta: () => delay<AutomationMeta>({ kinds: KINDS, events: EVENTS, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
  schedules: () => delay({ schedules: [...schedules].sort((a, b) => a.name.localeCompare(b.name)).map(view) }),
  createSchedule: (s) => {
    const error = check(s)
    if (error) return fail(error)
    schedules.push({ ...s, name: s.name.trim(), fun: s.fun ?? null, args: (s.args as Schedule['args']) ?? null, id: ++id, enabled: true, createdBy: 'demo', lastRunAt: null, lastJid: null, lastSummary: null, recentRuns: [] })
    return delay(undefined)
  },
  updateSchedule: (sid, changes) => {
    const s = schedules.find((x) => x.id === sid)
    if (!s) return fail('Not found')
    const merged = { ...s, ...changes } as typeof s & ScheduleInput
    const error = Object.keys(changes).length === 1 && 'enabled' in changes ? null : check(merged, s)
    if (error) return fail(error)
    Object.assign(s, changes)
    return delay(undefined)
  },
  deleteSchedule: (sid) => {
    const i = schedules.findIndex((x) => x.id === sid)
    if (i >= 0) schedules.splice(i, 1)
    return delay(undefined)
  },
  runSchedule: (sid) => {
    const s = schedules.find((x) => x.id === sid)
    if (!s) return fail('Not found')
    const at = new Date()
    const jid = jidAt(at)
    s.lastRunAt = at.toISOString()
    s.lastJid = jid
    s.recentRuns = [...s.recentRuns, { jid, startedAt: at.toISOString(), status: 'ok' as const, detail: 'run from the demo' }].slice(-10)
    return delay({ jid })
  },
  channels: () => delay({ channels: channels.map((c) => ({ ...c })) }),
  createChannel: (c) => {
    if (!c.name.trim()) return fail('Name is required')
    if (!/^https?:\/\//.test(c.url)) return fail('Webhook URL must use http or https')
    const masked = (() => {
      const u = new URL(c.url)
      return `${u.protocol}//${u.host}/…${(u.pathname + u.search).slice(-4)}`
    })()
    channels.push({ id: Math.max(0, ...channels.map((x) => x.id)) + 1, name: c.name.trim(), kind: c.kind as Channel['kind'], url: masked, events: c.events, enabled: true, lastSentAt: null, lastError: null })
    return delay(undefined)
  },
  updateChannel: (cid, changes) => {
    const c = channels.find((x) => x.id === cid)
    if (!c) return fail('Not found')
    Object.assign(c, changes)
    return delay(undefined)
  },
  deleteChannel: (cid) => {
    const i = channels.findIndex((x) => x.id === cid)
    if (i >= 0) channels.splice(i, 1)
    return delay(undefined)
  },
  // nothing leaves the browser in the demo
  testChannel: (cid) => {
    const c = channels.find((x) => x.id === cid)
    if (c) c.lastSentAt = new Date().toISOString()
    return delay(undefined)
  },
}
