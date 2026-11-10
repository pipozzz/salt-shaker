import { parseOsquery } from '../src/lib/osquery'
import type { Message } from './summaries'

/*
 * Scheduled osquery queries: each run is compared with the schedule's previous one, minion by
 * minion, so a new listening port, account or SSH key shows up as an added row.
 */

export interface OsqueryDiff {
  /** the first run (or the previous one had no rows to compare with): nothing to compare yet */
  baseline: boolean
  /** minions that answered, and the rows they returned */
  minions: number
  rows: number
  added: number
  removed: number
  /** minions with at least one added or removed row */
  changedMinions: number
  missing: number
  failed: number
  /** returns too large for the job history to keep (over 512 KB), so they can't be compared */
  tooLarge: number
  noreturn: number
  /** a few of the changes, e.g. "web-02: + username=tmpadmin shell=/bin/bash" */
  examples: string[]
}

type Return = { minion: string; ret: string | null }

const rowKey = (row: Record<string, string>) =>
  Object.entries(row)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')

/** Each minion's rows as keys; minions whose query failed or lack osquery are counted apart. */
function parse(returns: Return[]) {
  const rows = new Map<string, Set<string>>()
  let missing = 0
  let failed = 0
  let tooLarge = 0
  for (const r of returns) {
    let value: unknown = null
    try {
      value = r.ret ? JSON.parse(r.ret) : null
    } catch {
      value = r.ret
    }
    if (value && typeof value === 'object' && (value as { _truncated?: boolean })._truncated) {
      tooLarge++
      continue
    }
    const res = parseOsquery(value)
    if ('rows' in res) rows.set(r.minion, new Set(res.rows.map(rowKey)))
    else if (res.missing) missing++
    else failed++
  }
  return { rows, missing, failed, tooLarge }
}

const EXAMPLES = 10

/** What changed since the previous run, on the minions that answered both times. */
export function osqueryDiff(previous: Return[] | null, current: Return[], expected: number): OsqueryDiff {
  const now = parse(current)
  const before = previous ? parse(previous).rows : new Map<string, Set<string>>()
  const baseline = before.size === 0
  let added = 0
  let removed = 0
  let changedMinions = 0
  const examples: string[] = []
  const plus: string[] = []
  const minus: string[] = []
  for (const [minion, rows] of [...now.rows].sort(([a], [b]) => a.localeCompare(b))) {
    const old = before.get(minion)
    // a minion that didn't answer last time has nothing to compare with
    if (baseline || !old) continue
    const gained = [...rows].filter((k) => !old.has(k))
    const lost = [...old].filter((k) => !rows.has(k))
    added += gained.length
    removed += lost.length
    if (gained.length || lost.length) changedMinions++
    plus.push(...gained.map((k) => `${minion}: + ${k}`))
    minus.push(...lost.map((k) => `${minion}: − ${k}`))
  }
  examples.push(...plus.slice(0, EXAMPLES), ...minus.slice(0, Math.max(0, EXAMPLES - plus.length)))
  return {
    baseline,
    minions: now.rows.size,
    rows: [...now.rows.values()].reduce((n, s) => n + s.size, 0),
    added,
    removed,
    changedMinions,
    missing: now.missing,
    failed: now.failed,
    tooLarge: now.tooLarge,
    noreturn: Math.max(0, expected - current.length),
    examples,
  }
}

const minions = (n: number) => `${n} ${n === 1 ? 'minion' : 'minions'}`
const rowsOf = (n: number) => `${n} ${n === 1 ? 'row' : 'rows'}`

export function osqueryMessage(name: string, target: string, d: OsqueryDiff, jid: string): Message {
  const title = d.baseline
    ? `Query "${name}": first run, ${rowsOf(d.rows)} on ${minions(d.minions)}`
    : d.added || d.removed
      ? `Query "${name}": ${[d.added && `${d.added} new`, d.removed && `${d.removed} gone`].filter(Boolean).join(', ')} on ${minions(d.changedMinions)}`
      : `Query "${name}": no changes on ${minions(d.minions)}`
  const more = d.added + d.removed - d.examples.length
  return {
    title,
    lines: [
      `Target: ${target}`,
      ...d.examples,
      ...(more > 0 ? [`… and ${more} more`] : []),
      ...(d.missing ? [`osquery is not installed on ${minions(d.missing)}`] : []),
      ...(d.failed ? [`The query failed on ${minions(d.failed)}`] : []),
      ...(d.tooLarge ? [`The result on ${minions(d.tooLarge)} is too large to compare (over 512 KB); narrow the query`] : []),
      ...(d.noreturn ? [`${minions(d.noreturn)} did not return`] : []),
    ],
    severity: d.failed ? 'error' : !d.baseline && (d.added || d.removed) ? 'warning' : 'info',
    path: `/jobs/${jid}`,
  }
}
