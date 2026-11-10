import { toCsv } from '../lib/csv'
import type { AuditFilter, AuditRow } from './server'

/*
 * The demo's audit log: what the server would record, kept in the browser. Calls to the simulated
 * master that could change something, the console's own changes (schedules, channels, accepted
 * risks) and a few made-up entries from before, including a denied attempt.
 */

const rows: AuditRow[] = []
let id = 0

type Entry = Omit<AuditRow, 'id' | 'at' | 'role' | 'targetType' | 'args' | 'jid' | 'error' | 'ip'> &
  Partial<Pick<AuditRow, 'role' | 'targetType' | 'args' | 'jid' | 'error' | 'ip'>> & { at?: Date }

/** Adds an entry, newest first like the server's list. */
export function recordDemoAudit(e: Entry) {
  const row: AuditRow = { role: 'admin', targetType: null, args: null, jid: null, error: null, ip: '127.0.0.1', ...e, id: ++id, at: (e.at ?? new Date()).toISOString() }
  rows.push(row)
  rows.sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id)
  // ids follow time, newest highest, so paging by id works like the server's
  rows.forEach((r, i) => (r.id = rows.length - i))
}

/** The arguments as the server stores them for a salt call. */
export const saltArgs = (arg: unknown[] = [], kwarg: Record<string, unknown> = {}) => JSON.stringify({ arg, kwarg })

// from before the demo was opened: who did what, and one call a viewer wasn't allowed
const ago = (min: number) => new Date(Date.now() - min * 60_000)
recordDemoAudit({ at: ago(41 * 24 * 60), username: 'pam', client: 'admin', fun: 'schedule.create', target: 'Nightly compliance', outcome: 'ok' })
recordDemoAudit({ at: ago(41 * 24 * 60 - 5), username: 'pam', client: 'admin', fun: 'notification.create', target: 'Ops Slack', args: JSON.stringify({ kind: 'slack', events: ['drift', 'vulns'] }), outcome: 'ok' })
recordDemoAudit({ at: ago(7 * 60), username: 'vic', role: 'viewer', client: 'local', fun: 'cmd.run', target: 'db-01', targetType: 'glob', args: saltArgs(['cat /etc/shadow']), outcome: 'denied', error: 'Your role (viewer) may not run local cmd.run', ip: '10.0.9.7' })
recordDemoAudit({ at: ago(5 * 60), username: 'olga', role: 'operator', client: 'wheel', fun: 'key.accept', target: 'worker-01', outcome: 'denied', error: 'Your role (operator) may not run wheel key.accept', ip: '10.0.9.5' })

function matches(r: AuditRow, f: AuditFilter) {
  const q = f.q?.trim().toLowerCase()
  if (q && ![r.username, r.fun, r.target ?? ''].some((v) => v.toLowerCase().includes(q)) && r.jid !== q) return false
  if (f.outcome && r.outcome !== f.outcome) return false
  if (f.from && r.at < `${f.from}T00:00:00`) return false
  if (f.to && r.at >= new Date(Date.parse(`${f.to}T00:00:00Z`) + 86400_000).toISOString()) return false
  return true
}

const delay = <T>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 100))

export const demoAudit = {
  list: (opts: AuditFilter & { before?: number; limit?: number } = {}) => delay({ rows: rows.filter((r) => matches(r, opts) && (!opts.before || r.id < opts.before)).slice(0, opts.limit ?? 100) }),
  /** the same columns as the server's export */
  csv: (f: AuditFilter) =>
    toCsv([
      ['id', 'at', 'username', 'role', 'client', 'function', 'target', 'target_type', 'arguments', 'jid', 'outcome', 'error', 'ip'],
      ...rows.filter((r) => matches(r, f)).map((r) => [r.id, r.at, r.username, r.role, r.client, r.fun, r.target, r.targetType, r.args, r.jid, r.outcome, r.error, r.ip]),
    ]),
}
