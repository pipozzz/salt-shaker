import { isFailure, stateSummary } from './states'

/** Minions to run again after a job: those whose return failed, then those that never returned. */
export function retryTargets(results: Record<string, unknown>, expected: string[]) {
  const failed = Object.keys(results).filter((id) => isFailure(results[id])).sort()
  const missing = expected.filter((id) => !(id in results)).sort()
  return [...new Set([...failed, ...missing])]
}

const cell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v)
  // quote everything that could break a row, and defuse leading formula characters for spreadsheets
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
  return /[",\n\r]/.test(safe) || safe !== s ? `"${safe.replace(/"/g, '""')}"` : safe
}

/** One row per minion: status, state counts for state runs, and the raw return otherwise. */
export function resultsCsv(results: Record<string, unknown>, expected: string[] = []) {
  const ids = [...new Set([...expected, ...Object.keys(results)])].sort()
  const rows = [['minion', 'status', 'ok', 'changed', 'pending', 'failed', 'return']]
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
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n'
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
