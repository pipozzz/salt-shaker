import { diffFlat, flatten, type Row } from './compare'
import { lineDiff, type DiffLine } from './line-diff'
import { asStates, isFailure, stateSummary, type StateRet } from './states'

/*
 * Two runs of a job side by side, minion by minion: how each ended on it, and what differs in what
 * it returned. A state run is read state by state (what failed, changed or would change); any
 * other return as its values, or as text, line by line.
 */

/** How a job ended on a minion; `absent` when it wasn't targeted, `missing` when it didn't return. */
export type Outcome = 'ok' | 'changed' | 'pending' | 'failed' | 'missing' | 'absent'

export function outcome(ret: unknown, returned: boolean, targeted: boolean): Outcome {
  if (!returned) return targeted ? 'missing' : 'absent'
  if (isFailure(ret)) return 'failed'
  const sum = stateSummary(ret)
  if (sum?.pending) return 'pending'
  if (sum?.changed) return 'changed'
  return 'ok'
}

export type StateOutcome = 'ok' | 'changed' | 'pending' | 'failed'

function stateOutcome(s: StateRet): StateOutcome {
  if (s.result === false) return 'failed'
  if (s.result === null) return 'pending'
  return s.changes && Object.keys(s.changes).length ? 'changed' : 'ok'
}

/** `pkg_|-nginx_|-nginx_|-installed` → `pkg.installed nginx`, as the state output reads it. */
export function stateLabel(key: string, s?: StateRet) {
  const [mod, id, name, fun] = key.split('_|-')
  const label = `${mod}.${fun ?? ''} ${s?.name ?? name ?? id}`
  return id && id !== (s?.name ?? name) ? `${label} (${id})` : label
}

export interface StateRow {
  key: string
  label: string
  a: StateOutcome | null
  b: StateOutcome | null
  aComment?: string
  bComment?: string
}

export type Detail =
  | { kind: 'states'; differ: StateRow[]; same: number }
  | { kind: 'values'; differ: Row[]; same: number }
  | { kind: 'text'; lines: DiffLine[] }
  | { kind: 'none' }

const asText = (ret: unknown) => (typeof ret === 'string' ? ret : Array.isArray(ret) && ret.every((x) => typeof x === 'string') ? ret.join('\n') : null)

/** What differs between two returns of one minion. */
export function diffReturns(a: unknown, b: unknown): Detail {
  const sa = asStates(a)
  const sb = asStates(b)
  if (sa || sb) {
    const ma = new Map(sa ?? [])
    const mb = new Map(sb ?? [])
    // in the order they ran, the second run's for states only it has
    const keys = [...new Set([...ma.keys(), ...mb.keys()])]
    const order = (k: string) => mb.get(k)?.__run_num__ ?? ma.get(k)?.__run_num__ ?? 0
    keys.sort((x, y) => order(x) - order(y))
    const differ: StateRow[] = []
    let same = 0
    for (const key of keys) {
      const x = ma.get(key)
      const y = mb.get(key)
      const ox = x ? stateOutcome(x) : null
      const oy = y ? stateOutcome(y) : null
      if (ox === oy) {
        same++
        continue
      }
      differ.push({ key, label: stateLabel(key, y ?? x), a: ox, b: oy, aComment: x?.comment, bComment: y?.comment })
    }
    return { kind: 'states', differ, same }
  }
  const ta = asText(a)
  const tb = asText(b)
  if (ta !== null || tb !== null) {
    if (ta === tb) return { kind: 'none' }
    return { kind: 'text', lines: lineDiff(ta ?? (a === undefined ? '' : JSON.stringify(a, null, 2)), tb ?? (b === undefined ? '' : JSON.stringify(b, null, 2))) }
  }
  if (a === undefined || b === undefined) return { kind: 'none' }
  const fa = flatten(a === null || typeof a !== 'object' ? { value: a } : a)
  const fb = flatten(b === null || typeof b !== 'object' ? { value: b } : b)
  const { differ, identity, same } = diffFlat(fa, fb)
  const all = [...differ, ...identity].sort((x, y) => x.key.localeCompare(y.key))
  return all.length ? { kind: 'values', differ: all, same } : { kind: 'none' }
}

export interface MinionCompare {
  id: string
  a: Outcome
  b: Outcome
  detail: Detail
  /** it ended differently, or returned something else */
  differs: boolean
}

interface JobSide {
  results: Record<string, unknown>
  minions: string[]
}

/** Every minion either job targeted or heard from, those that differ first. */
export function compareJobs(a: JobSide, b: JobSide): MinionCompare[] {
  const ids = [...new Set([...a.minions, ...Object.keys(a.results), ...b.minions, ...Object.keys(b.results)])].sort()
  const rows = ids.map((id): MinionCompare => {
    const ra = id in a.results
    const rb = id in b.results
    const oa = outcome(a.results[id], ra, a.minions.includes(id))
    const ob = outcome(b.results[id], rb, b.minions.includes(id))
    const detail = ra && rb ? diffReturns(a.results[id], b.results[id]) : { kind: 'none' as const }
    const changed = detail.kind === 'states' || detail.kind === 'values' ? detail.differ.length > 0 : detail.kind === 'text'
    return { id, a: oa, b: ob, detail, differs: oa !== ob || changed }
  })
  return [...rows.filter((r) => r.differs), ...rows.filter((r) => !r.differs)]
}
