/** Pure helpers for Salt state returns, shared by the UI and the server. */

export interface StateRet {
  __id__?: string
  __sls__?: string
  __run_num__?: number
  name?: string
  result: boolean | null
  comment?: string
  changes?: Record<string, unknown>
  duration?: number
}

export function asStates(ret: unknown): Array<[string, StateRet]> | null {
  if (!ret || typeof ret !== 'object' || Array.isArray(ret)) return null
  const entries = Object.entries(ret as Record<string, unknown>)
  if (entries.length === 0 || !entries.every(([k, v]) => k.includes('_|-') && v && typeof v === 'object' && 'result' in v)) return null
  return (entries as Array<[string, StateRet]>).sort((a, b) => (a[1].__run_num__ ?? 0) - (b[1].__run_num__ ?? 0))
}

export function stateSummary(ret: unknown) {
  const states = asStates(ret)
  if (!states) return null
  const s = { ok: 0, changed: 0, failed: 0, pending: 0, duration: 0 }
  for (const [, st] of states) {
    if (st.result === false) s.failed++
    else if (st.result === null) s.pending++
    else if (st.changes && Object.keys(st.changes).length) s.changed++
    else s.ok++
    s.duration += st.duration ?? 0
  }
  return s
}

/** Did a minion's return look like a failure? */
export function isFailure(ret: unknown) {
  const sum = stateSummary(ret)
  if (sum) return sum.failed > 0
  if (Array.isArray(ret) && ret.every((x) => typeof x === 'string')) return ret.some((x) => /^(Rendering SLS|No matching sls|Pillar failed)/.test(x))
  if (typeof ret === 'string') return /is not available|Traceback|ERROR|Minion did not return/.test(ret)
  return ret === false
}
