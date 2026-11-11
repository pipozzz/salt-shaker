import { asStates, type StateRet } from './states'

/*
 * What a branch (a gitfs saltenv) would do on a minion compared with base: both are dry runs of
 * the highstate (test=True), and only the states whose outcome differs are kept.
 */

export type DeltaKind =
  /** the branch would change or create it, base wouldn't */
  | 'changes'
  /** a state only the branch has, that would change something */
  | 'new'
  /** it would fail with the branch, not with base */
  | 'fails'
  /** base would change it, the branch wouldn't (the branch already matches the minion, or stops managing that) */
  | 'settles'
  /** base has it, the branch doesn't apply it any more (Salt leaves what it managed in place) */
  | 'dropped'

export interface StateDelta {
  key: string
  id: string
  sls?: string
  name?: string
  kind: DeltaKind
  comment?: string
  changes?: Record<string, unknown>
}

export type EnvDiff = { deltas: StateDelta[] } | { error: string }

const would = (s: StateRet) => s.result === null || (!!s.changes && Object.keys(s.changes).length > 0)
const failed = (s: StateRet) => s.result === false
const ORDER: Record<DeltaKind, number> = { fails: 0, changes: 1, new: 2, dropped: 3, settles: 4 }

/** A short reason when a return isn't a state run (the branch doesn't render, say). */
function notStates(ret: unknown) {
  if (Array.isArray(ret)) return ret.map(String).join('\n').slice(0, 300)
  if (typeof ret === 'string') return ret.slice(0, 300)
  return 'Not a state run'
}

export function envDiff(base: unknown, branch: unknown): EnvDiff {
  const b = asStates(branch)
  if (!b) return { error: notStates(branch) }
  const a = new Map(asStates(base) ?? [])
  const deltas: StateDelta[] = []
  const add = (key: string, s: StateRet, kind: DeltaKind) => deltas.push({ key, id: s.__id__ ?? key.split('_|-')[1] ?? key, sls: s.__sls__, name: s.name, kind, comment: s.comment, changes: s.changes && Object.keys(s.changes).length ? s.changes : undefined })
  for (const [key, s] of b) {
    const before = a.get(key)
    a.delete(key)
    if (!before) {
      if (failed(s)) add(key, s, 'fails')
      else if (would(s)) add(key, s, 'new')
      continue
    }
    if (failed(s) && !failed(before)) add(key, s, 'fails')
    else if (would(s) && !would(before)) add(key, s, 'changes')
    else if (!would(s) && would(before)) add(key, s, 'settles')
  }
  for (const [key, s] of a) add(key, s, 'dropped')
  deltas.sort((x, y) => ORDER[x.kind] - ORDER[y.kind] || (x.sls ?? '').localeCompare(y.sls ?? '') || x.id.localeCompare(y.id))
  return { deltas }
}

export const DELTA_LABEL: Record<DeltaKind, string> = {
  fails: 'would fail',
  changes: 'would change',
  new: 'new, would change',
  settles: 'no longer changes',
  dropped: 'not applied any more',
}
