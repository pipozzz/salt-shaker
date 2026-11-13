import type { Grains, TargetType } from '../api/types'

/*
 * The Minions page's filters as a Salt target, to save under a name: the fleet breakdown pick is
 * grains, and a saved target picked as a filter is itself. The search and Up / Down / Drifted
 * change from moment to moment and aren't a target, so a list filtered by them saves as the
 * minions it shows.
 */

export type FacetKind = 'os' | 'salt' | 'role'
export interface Facet {
  kind: FacetKind
  value: string
}
export interface Target {
  tgt: string
  tgtType: TargetType
}

/** The longest target the server keeps. */
export const MAX_TARGET = 2000

const PREFIX: Partial<Record<TargetType, string>> = { list: 'L@', grain: 'G@', pcre: 'E@', pillar: 'I@', nodegroup: 'N@' }

/** A target as one part of a compound one, or null when it can't be (a glob with spaces). */
export function asCompound(t: Target): string | null {
  const tgt = t.tgt.trim()
  if (t.tgtType === 'compound') return `( ${tgt} )`
  if (/\s/.test(tgt)) return null
  return t.tgtType === 'glob' ? tgt : `${PREFIX[t.tgtType]}${tgt}`
}

/** The grains a breakdown pick stands for, as `key:value` pairs; null when a value has a space. */
export function facetGrains(f: Facet, grains: Record<string, Grains>): string[] | null {
  let pairs: string[]
  if (f.kind === 'salt') pairs = [`saltversion:${f.value}`]
  else if (f.kind === 'role') pairs = [`roles:${f.value}`]
  else {
    // "Ubuntu 22.04" is two grains: find a minion it was read from
    const g = Object.values(grains).find((g) => g && g.os && `${g.os} ${g.osrelease ?? ''}`.trim() === f.value)
    if (!g?.os) return null
    pairs = [`os:${g.os}`, ...(g.osrelease ? [`osrelease:${g.osrelease}`] : [])]
  }
  return pairs.some((p) => /\s/.test(p)) ? null : pairs
}

/**
 * The target that matches what the breakdown pick and the saved target pick: either alone as
 * itself, both joined with `and`. Null when nothing is picked, or a part can't be a target.
 */
export function filterTarget({ saved, facet, grains }: { saved?: Target | null; facet?: Facet | null; grains: Record<string, Grains> }): Target | null {
  const pairs = facet ? facetGrains(facet, grains) : []
  if (!pairs) return null
  if (!saved) {
    if (!pairs.length) return null
    return pairs.length === 1 ? { tgt: pairs[0], tgtType: 'grain' } : { tgt: pairs.map((p) => `G@${p}`).join(' and '), tgtType: 'compound' }
  }
  if (!pairs.length) return { tgt: saved.tgt.trim(), tgtType: saved.tgtType }
  const first = asCompound(saved)
  if (!first) return null
  return { tgt: [first, ...pairs.map((p) => `G@${p}`)].join(' and '), tgtType: 'compound' }
}

/** These minions, as a list target; null when there are too many to keep. */
export function listTarget(ids: string[]): Target | null {
  const tgt = [...ids].sort().join(',')
  return tgt && tgt.length <= MAX_TARGET ? { tgt, tgtType: 'list' } : null
}
