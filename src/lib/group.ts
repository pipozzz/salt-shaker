import { isFailure, stateSummary } from './states'

export interface OutputGroup {
  /** canonical JSON of the output, the same for equal outputs whatever their key order */
  key: string
  ret: unknown
  ids: string[]
  failed: boolean
}

/** JSON with object keys sorted, so equal returns compare equal. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/**
 * Minions grouped by identical output, biggest group first (failed groups before others of the
 * same size). Null when grouping doesn't help: state runs, which have their own summaries, or
 * when every minion returned something different.
 */
export function groupByOutput(results: Record<string, unknown>): OutputGroup[] | null {
  const ids = Object.keys(results).sort()
  if (ids.length < 2 || ids.some((id) => stateSummary(results[id]))) return null
  const groups = new Map<string, OutputGroup>()
  for (const id of ids) {
    const key = canonical(results[id])
    const g = groups.get(key)
    if (g) g.ids.push(id)
    else groups.set(key, { key, ret: results[id], ids: [id], failed: isFailure(results[id]) })
  }
  if (groups.size === ids.length) return null
  return [...groups.values()].sort((a, b) => b.ids.length - a.ids.length || Number(b.failed) - Number(a.failed) || a.ids[0].localeCompare(b.ids[0]))
}
