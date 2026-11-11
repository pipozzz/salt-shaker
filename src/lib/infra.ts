import type { Grains } from '../api/types'

/*
 * The infrastructure map: minions laid out in nested groups by what they share (network, role,
 * OS, where they run) and coloured by one state at a time. Pure, so the page only draws it.
 */

export const GROUPINGS = {
  subnet: 'Network (/24)',
  role: 'Role',
  os: 'Operating system',
  virtual: 'Platform',
  none: 'Nothing',
} as const
export type Grouping = keyof typeof GROUPINGS

/** The first address that isn't loopback, as its /24. */
export function subnetOf(g: Grains) {
  const ip = (g.ipv4 ?? []).find((a) => !a.startsWith('127.') && /^\d+\.\d+\.\d+\.\d+$/.test(a))
  return ip ? `${ip.split('.').slice(0, 3).join('.')}.0/24` : 'no address'
}

/** Which group a minion belongs to; a minion with several roles goes under its first. */
export function groupKey(by: Grouping, g: Grains): string {
  switch (by) {
    case 'subnet':
      return subnetOf(g)
    case 'role':
      return g.roles?.[0] ?? 'no role'
    case 'os':
      return g.os ? `${g.os}${g.osrelease ? ` ${String(g.osrelease).split('.')[0]}` : ''}` : 'unknown OS'
    case 'virtual':
      return typeof g.virtual === 'string' && g.virtual ? g.virtual : 'unknown'
    case 'none':
      return 'All minions'
  }
}

export interface Tile {
  id: string
  g: Grains
}

export interface Group {
  key: string
  count: number
  groups: Array<{ key: string; tiles: Tile[] }>
}

// a missing value sorts last, so real groups come first
const isMissing = (k: string) => /^(no |unknown)/.test(k)
const byKey = (a: string, b: string) => Number(isMissing(a)) - Number(isMissing(b)) || a.localeCompare(b, undefined, { numeric: true })

/** Two levels of groups, the bigger outer groups first; inner groups and tiles in name order. */
export function layout(tiles: Tile[], outer: Grouping, inner: Grouping): Group[] {
  const map = new Map<string, Map<string, Tile[]>>()
  for (const t of tiles) {
    const o = groupKey(outer, t.g)
    const i = inner === outer ? '' : groupKey(inner, t.g)
    if (!map.has(o)) map.set(o, new Map())
    const m = map.get(o)!
    if (!m.has(i)) m.set(i, [])
    m.get(i)!.push(t)
  }
  return [...map.entries()]
    .map(([key, m]) => ({
      key,
      count: [...m.values()].reduce((n, ts) => n + ts.length, 0),
      groups: [...m.entries()].sort((a, b) => byKey(a[0], b[0])).map(([k, ts]) => ({ key: k, tiles: ts.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })) })),
    }))
    .sort((a, b) => Number(isMissing(a.key)) - Number(isMissing(b.key)) || b.count - a.count || a.key.localeCompare(b.key))
}

export const OVERLAYS = {
  status: 'Answers',
  compliance: 'Compliance',
  vulns: 'Vulnerabilities',
  salt: 'Salt version',
} as const
export type Overlay = keyof typeof OVERLAYS

export type Level = 'good' | 'warning' | 'critical' | 'unknown'

/** What each overlay knows: any of these can be missing (not loaded yet, or not available here). */
export interface MapState {
  up?: Set<string> | null
  compliance?: Record<string, { status: 'ok' | 'drift' | 'error' }> | null
  vulns?: Map<string, { critical: number; high: number }> | null
  masterVersion?: string | null
}

/** The level and its words for one minion under an overlay. */
export function levelOf(overlay: Overlay, t: Tile, s: MapState): { level: Level; label: string } {
  switch (overlay) {
    case 'status':
      if (!s.up) return { level: 'unknown', label: 'checking…' }
      return s.up.has(t.id) ? { level: 'good', label: 'answers' } : { level: 'critical', label: 'not answering' }
    case 'compliance': {
      const c = s.compliance?.[t.id]
      if (!c) return { level: 'unknown', label: 'not checked' }
      return c.status === 'ok' ? { level: 'good', label: 'in compliance' } : c.status === 'drift' ? { level: 'warning', label: 'drifted' } : { level: 'critical', label: 'errors' }
    }
    case 'vulns': {
      const v = s.vulns?.get(t.id)
      if (!v) return { level: 'unknown', label: 'not scanned' }
      if (v.critical) return { level: 'critical', label: `${v.critical} critical` }
      if (v.high) return { level: 'warning', label: `${v.high} high` }
      return { level: 'good', label: 'no critical or high' }
    }
    case 'salt': {
      const v = typeof t.g.saltversion === 'string' ? t.g.saltversion : null
      if (!v || !s.masterVersion) return { level: 'unknown', label: v ?? 'unknown version' }
      const major = (x: string) => Number(x.split('.')[0])
      if (v === s.masterVersion) return { level: 'good', label: v }
      return major(v) < major(s.masterVersion) ? { level: 'critical', label: `${v}, a major behind` } : { level: 'warning', label: `${v}, not ${s.masterVersion}` }
    }
  }
}

export const LEVEL_WORDS: Record<Overlay, Record<Level, string>> = {
  status: { good: 'answers', warning: '', critical: 'not answering', unknown: 'checking' },
  compliance: { good: 'in compliance', warning: 'drifted', critical: 'errors', unknown: 'not checked' },
  vulns: { good: 'no critical or high', warning: 'high', critical: 'critical', unknown: 'not scanned' },
  salt: { good: 'same as the master', warning: 'other release', critical: 'major version behind', unknown: 'unknown' },
}

/** How many minions are at each level, for the legend. */
export function levelCounts(overlay: Overlay, tiles: Tile[], s: MapState) {
  const counts: Record<Level, number> = { good: 0, warning: 0, critical: 0, unknown: 0 }
  for (const t of tiles) counts[levelOf(overlay, t, s).level]++
  return counts
}
