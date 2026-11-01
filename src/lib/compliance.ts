import { stateSummary } from './states'

/** How one minion's `state.apply test=True` return reads for compliance. */
export type Status = 'error' | 'drift' | 'noreturn' | 'ok' | 'waiting'

export interface Row {
  id: string
  status: Status
  ret?: unknown
  wouldChange: number
  failed: number
}

export const ORDER: Record<Status, number> = { error: 0, drift: 1, noreturn: 2, waiting: 3, ok: 4 }

export function classify(id: string, results: Record<string, unknown>, done: boolean): Row {
  if (!(id in results)) return { id, status: done ? 'noreturn' : 'waiting', wouldChange: 0, failed: 0 }
  const ret = results[id]
  const sum = stateSummary(ret)
  // a non-state return from state.apply means the run never started (render error, no top match…)
  if (!sum) return { id, status: 'error', ret, wouldChange: 0, failed: 0 }
  const wouldChange = sum.pending + sum.changed
  return { id, status: sum.failed ? 'error' : wouldChange ? 'drift' : 'ok', ret, wouldChange, failed: sum.failed }
}
