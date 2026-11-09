/** Turns stored job returns into the short summaries shown in history and sent in notifications. */

export interface StoredReturn {
  minion: string
  ret: string | null
  retcode: number | null
  success: boolean | null
  summary: string | null
}

export interface ComplianceCounts {
  ok: number
  drift: number
  error: number
  noreturn: number
}

/** One minion's bucket in a compliance check: failed or non-state returns are errors. */
export function complianceStatus(summary: string | null): 'ok' | 'drift' | 'error' {
  const s = summary ? (JSON.parse(summary) as { failed: number; pending: number; changed: number }) : null
  if (!s || s.failed) return 'error'
  return s.pending + s.changed ? 'drift' : 'ok'
}

/** Same buckets as the Compliance page. */
export function complianceCounts(returns: Array<Pick<StoredReturn, 'summary'>>, expectedMinions: number): ComplianceCounts {
  const counts = { ok: 0, drift: 0, error: 0, noreturn: 0 }
  for (const r of returns) counts[complianceStatus(r.summary)]++
  counts.noreturn = Math.max(0, expectedMinions - returns.length)
  return counts
}

export interface PatchSummary {
  scanned: number
  needUpdates: number
  packages: number
  /** package -> number of minions that have an upgrade for it */
  top: Array<[string, number]>
  noreturn: number
}

export function patchSummary(returns: Array<Pick<StoredReturn, 'ret'>>, expectedMinions: number): PatchSummary {
  const perPackage = new Map<string, number>()
  let needUpdates = 0
  for (const r of returns) {
    const ups = r.ret ? (JSON.parse(r.ret) as unknown) : null
    if (!ups || typeof ups !== 'object' || Array.isArray(ups)) continue
    const names = Object.keys(ups)
    if (names.length) needUpdates++
    for (const n of names) perPackage.set(n, (perPackage.get(n) ?? 0) + 1)
  }
  const top = [...perPackage.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5)
  return { scanned: returns.length, needUpdates, packages: perPackage.size, top, noreturn: Math.max(0, expectedMinions - returns.length) }
}

export function failureSummary(returns: Array<Pick<StoredReturn, 'minion' | 'retcode' | 'success'>>, expectedMinions: number) {
  const failed = returns.filter((r) => (r.retcode ?? 0) !== 0 || r.success === false).map((r) => r.minion)
  return { returned: returns.length, failed, noreturn: Math.max(0, expectedMinions - returns.length) }
}

export type Severity = 'info' | 'warning' | 'error'

export interface Message {
  title: string
  lines: string[]
  severity: Severity
  /** path inside Salt Shaker, e.g. /jobs/<jid> */
  path?: string
}

const minions = (n: number) => `${n} ${n === 1 ? 'minion' : 'minions'}`
const list = (ids: string[], max = 5) => ids.slice(0, max).join(', ') + (ids.length > max ? ` +${ids.length - max} more` : '')

export function complianceMessage(name: string, target: string, c: ComplianceCounts, jid: string): Message {
  const bad = c.drift + c.error
  return {
    title: bad ? `Compliance "${name}": ${c.drift} drifted, ${c.error} with errors` : `Compliance "${name}": all ${minions(c.ok)} in compliance`,
    lines: [`Target: ${target}`, `${c.ok} ok · ${c.drift} drifted · ${c.error} errors · ${c.noreturn} no return`],
    severity: c.error ? 'error' : bad || c.noreturn ? 'warning' : 'info',
    path: `/jobs/${jid}`,
  }
}

export function patchMessage(name: string, target: string, p: PatchSummary, jid: string): Message {
  return {
    title: p.needUpdates ? `Patches "${name}": ${minions(p.needUpdates)} with ${p.packages} ${p.packages === 1 ? 'package' : 'packages'} to upgrade` : `Patches "${name}": everything up to date`,
    lines: [`Target: ${target}`, ...(p.top.length ? [`Most common: ${p.top.map(([n, k]) => `${n} (${k})`).join(', ')}`] : []), ...(p.noreturn ? [`${minions(p.noreturn)} did not return`] : [])],
    severity: p.needUpdates ? 'warning' : 'info',
    path: `/jobs/${jid}`,
  }
}

export function functionMessage(name: string, fun: string, target: string, f: ReturnType<typeof failureSummary>, jid: string): Message {
  return {
    title: f.failed.length ? `Schedule "${name}": ${fun} failed on ${minions(f.failed.length)}` : `Schedule "${name}": ${fun} succeeded on ${minions(f.returned)}`,
    lines: [`Target: ${target}`, ...(f.failed.length ? [`Failed: ${list(f.failed)}`] : []), ...(f.noreturn ? [`${minions(f.noreturn)} did not return`] : [])],
    severity: f.failed.length ? 'error' : f.noreturn ? 'warning' : 'info',
    path: `/jobs/${jid}`,
  }
}

export function jobFailedMessage(fun: string, failedMinions: string[], by: string | null, jid: string): Message {
  return {
    title: `${fun} failed on ${minions(failedMinions.length)}`,
    lines: [`Minions: ${list(failedMinions)}`, ...(by ? [`Started by: ${by}`] : [])],
    severity: 'error',
    path: `/jobs/${jid}`,
  }
}

export function pendingKeyMessage(id: string): Message {
  return { title: `New minion waiting for approval: ${id}`, lines: ['Check its key fingerprint before accepting it.'], severity: 'warning', path: '/keys' }
}

export function minionsDownMessage(ids: string[]): Message {
  return {
    title: ids.length === 1 ? `Minion stopped responding: ${ids[0]}` : `${minions(ids.length)} stopped responding`,
    lines: [...(ids.length > 1 ? [`Minions: ${list(ids)}`] : []), 'It did not answer the last two checks (manage.status).'],
    severity: 'error',
    path: ids.length === 1 ? `/minions/${encodeURIComponent(ids[0])}` : '/',
  }
}

export function minionsUpMessage(ids: string[]): Message {
  return {
    title: ids.length === 1 ? `Minion is responding again: ${ids[0]}` : `${minions(ids.length)} are responding again`,
    lines: ids.length > 1 ? [`Minions: ${list(ids)}`] : [],
    severity: 'info',
    path: ids.length === 1 ? `/minions/${encodeURIComponent(ids[0])}` : '/',
  }
}

export function vulnMessage(name: string, target: string, v: { scanned: number; notCovered: number; affected: number; critical: number; high: number; fixable: number; noreturn: number }, error: string | null): Message {
  const found = v.critical + v.high
  const counts = [v.critical && `${v.critical} critical`, v.high && `${v.high} high`].filter(Boolean).join(' and ')
  return {
    title: found ? `Vulnerabilities "${name}": ${counts} on ${minions(v.affected)}, ${v.fixable} with a fix` : `Vulnerabilities "${name}": nothing critical or high on ${minions(v.scanned)}`,
    lines: [
      `Target: ${target}`,
      ...(v.notCovered ? [`${minions(v.notCovered)} not covered (unsupported OS or the scan failed)`] : []),
      ...(v.noreturn ? [`${minions(v.noreturn)} did not return`] : []),
      ...(error ? [error] : []),
    ],
    severity: v.critical ? 'error' : found ? 'warning' : 'info',
    path: '/vulnerabilities',
  }
}
