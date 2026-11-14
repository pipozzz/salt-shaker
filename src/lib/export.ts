import { toCsv } from './csv'
import type { Grains } from '../api/types'
import { isFailure, stateSummary } from './states'

/** Minions to run again after a job: those whose return failed, then those that never returned. */
export function retryTargets(results: Record<string, unknown>, expected: string[]) {
  const failed = Object.keys(results).filter((id) => isFailure(results[id])).sort()
  const missing = expected.filter((id) => !(id in results)).sort()
  return [...new Set([...failed, ...missing])]
}

/** One row per minion: status, state counts for state runs, and the raw return otherwise. */
export function resultsCsv(results: Record<string, unknown>, expected: string[] = []) {
  const ids = [...new Set([...expected, ...Object.keys(results)])].sort()
  const rows: unknown[][] = [['minion', 'status', 'ok', 'changed', 'pending', 'failed', 'return']]
  for (const id of ids) {
    if (!(id in results)) {
      rows.push([id, 'no return', '', '', '', '', ''])
      continue
    }
    const ret = results[id]
    const sum = stateSummary(ret)
    const status = isFailure(ret) ? 'failed' : 'ok'
    if (sum) rows.push([id, status, String(sum.ok), String(sum.changed), String(sum.pending), String(sum.failed), ''])
    else rows.push([id, status, '', '', '', '', typeof ret === 'string' ? ret : JSON.stringify(ret)])
  }
  return toCsv(rows)
}

/** Everything about a job in one JSON document, with "no return" made explicit. */
export function resultsJson(job: { jid: string; fun: string; target?: string; targetType?: string }, results: Record<string, unknown>, expected: string[] = []) {
  const missing = expected.filter((id) => !(id in results)).sort()
  return JSON.stringify({ ...job, returns: results, noReturn: missing }, null, 2) + '\n'
}

/** Hands the browser a file to save. */
export function download(name: string, type: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export interface InventoryRow {
  id: string
  up?: boolean
  g: Grains
  compliance?: { status: string; checkedAt: string }
  updates?: { packages: number; checkedAt: string }
  vulns?: { error: string | null; scannedAt: string; counts: Record<'critical' | 'high' | 'medium' | 'low' | 'unknown' | 'fixable', number> }
  /** the team's note on it, when notes are kept */
  note?: string
}

/**
 * The minions list as an inventory spreadsheet: one row per minion with its key grains. The
 * compliance and patch columns are only there when the server records them.
 */
export function minionsCsv(rows: InventoryRow[], withServer: boolean, withNotes = false) {
  const head = ['minion', 'status', 'os', 'os_release', 'kernel', 'ipv4', 'cpus', 'memory_mb', 'virtual', 'roles', 'salt_version']
  if (withServer) head.push('compliance', 'compliance_checked_at', 'pending_updates', 'updates_checked_at', 'vulnerabilities', 'critical', 'high', 'with_fix', 'inventory_at')
  if (withNotes) head.push('note')
  const out: unknown[][] = [head]
  for (const { id, up, g, compliance, updates, vulns, note } of rows) {
    const list = (v: unknown) => (Array.isArray(v) ? v.join(' ') : '')
    const row: unknown[] = [
      id,
      up === undefined ? 'unknown' : up ? 'up' : 'down',
      g.os ?? '',
      g.osrelease ?? '',
      g.kernelrelease ?? '',
      list(g.ipv4?.filter((ip) => ip !== '127.0.0.1')),
      g.num_cpus ?? '',
      g.mem_total ?? '',
      g.virtual ?? '',
      list(g.roles),
      g.saltversion ?? '',
    ]
    if (withServer) {
      const c = vulns && !vulns.error ? vulns.counts : null
      row.push(compliance?.status ?? '', compliance?.checkedAt ?? '', updates ? updates.packages : '', updates?.checkedAt ?? '')
      row.push(c ? c.critical + c.high + c.medium + c.low + c.unknown : '', c?.critical ?? '', c?.high ?? '', c?.fixable ?? '', c ? vulns!.scannedAt : '')
    }
    if (withNotes) row.push(note ?? '')
    out.push(row.map((v) => (typeof v === 'number' ? String(v) : v)))
  }
  return toCsv(out)
}

export interface FindingRow {
  minion: string
  os: string | null
  scannedAt: string | Date
  package: string
  binaries: string[]
  version: string
  id: string
  cves: string[]
  severity: string
  score: number | null
  fixed: string | null
  summary: string
}

/** Every vulnerability found, one row per minion and package, for spreadsheets and ticketing. */
export function findingsCsv(rows: FindingRow[]) {
  const out: unknown[][] = [['minion', 'os', 'package', 'installed_packages', 'installed_version', 'vulnerability', 'cves', 'severity', 'cvss', 'fixed_in', 'summary', 'inventory_at']]
  for (const r of rows) {
    const at = typeof r.scannedAt === 'string' ? r.scannedAt : r.scannedAt.toISOString()
    out.push([r.minion, r.os ?? '', r.package, r.binaries.join(' '), r.version, r.id, r.cves.join(' '), r.severity, r.score === null ? '' : String(r.score), r.fixed ?? '', r.summary, at])
  }
  return toCsv(out)
}
