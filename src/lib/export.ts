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
}

/**
 * The minions list as an inventory spreadsheet: one row per minion with its key grains. The
 * compliance and patch columns are only there when the server records them.
 */
export function minionsCsv(rows: InventoryRow[], withServer: boolean) {
  const head = ['minion', 'status', 'os', 'os_release', 'kernel', 'ipv4', 'cpus', 'memory_mb', 'virtual', 'roles', 'salt_version']
  if (withServer) head.push('compliance', 'compliance_checked_at', 'pending_updates', 'updates_checked_at')
  const out: unknown[][] = [head]
  for (const { id, up, g, compliance, updates } of rows) {
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
    if (withServer) row.push(compliance?.status ?? '', compliance?.checkedAt ?? '', updates ? updates.packages : '', updates?.checkedAt ?? '')
    out.push(row.map((v) => (typeof v === 'number' ? String(v) : v)))
  }
  return toCsv(out)
}
