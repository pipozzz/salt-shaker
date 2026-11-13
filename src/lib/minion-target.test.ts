import { describe, expect, it } from 'vitest'
import { demoMatch } from '../api/mock'
import type { Grains } from '../api/types'
import { asCompound, facetGrains, filterTarget, listTarget, MAX_TARGET } from './minion-target'

const grains = {
  'web-01': { os: 'Ubuntu', osrelease: '24.04' },
  'win-01': { os: 'Windows', osrelease: 'Server 2022' },
  'old-01': { os: 'Arch' },
} as unknown as Record<string, Grains>

describe('the Minions filter as a target', () => {
  it('turns a breakdown pick into grains', () => {
    expect(facetGrains({ kind: 'role', value: 'web' }, grains)).toEqual(['roles:web'])
    expect(facetGrains({ kind: 'salt', value: '3007.1' }, grains)).toEqual(['saltversion:3007.1'])
    expect(facetGrains({ kind: 'os', value: 'Ubuntu 24.04' }, grains)).toEqual(['os:Ubuntu', 'osrelease:24.04'])
    expect(facetGrains({ kind: 'os', value: 'Arch' }, grains)).toEqual(['os:Arch'])
  })

  it("can't when a grain has a space, or no minion has it", () => {
    expect(facetGrains({ kind: 'os', value: 'Windows Server 2022' }, grains)).toBeNull()
    expect(facetGrains({ kind: 'os', value: 'Plan9' }, grains)).toBeNull()
    expect(filterTarget({ facet: { kind: 'os', value: 'Windows Server 2022' }, grains })).toBeNull()
  })

  it('is one grain, or grains joined with and', () => {
    expect(filterTarget({ grains })).toBeNull()
    expect(filterTarget({ facet: { kind: 'role', value: 'web' }, grains })).toEqual({ tgt: 'roles:web', tgtType: 'grain' })
    expect(filterTarget({ facet: { kind: 'os', value: 'Ubuntu 24.04' }, grains })).toEqual({ tgt: 'G@os:Ubuntu and G@osrelease:24.04', tgtType: 'compound' })
  })

  it('keeps a saved target as it is, or joins it with the pick', () => {
    const saved = { tgt: 'web-*', tgtType: 'glob' as const }
    expect(filterTarget({ saved, grains })).toEqual(saved)
    expect(filterTarget({ saved, facet: { kind: 'role', value: 'web' }, grains })).toEqual({ tgt: 'web-* and G@roles:web', tgtType: 'compound' })
    expect(filterTarget({ saved: { tgt: 'G@os:Debian or db*', tgtType: 'compound' }, facet: { kind: 'salt', value: '3007.1' }, grains })).toEqual({
      tgt: '( G@os:Debian or db* ) and G@saltversion:3007.1',
      tgtType: 'compound',
    })
    expect(filterTarget({ saved: { tgt: 'web a', tgtType: 'glob' }, facet: { kind: 'role', value: 'web' }, grains })).toBeNull()
  })

  it('writes each kind of target as part of a compound one', () => {
    expect(asCompound({ tgt: 'a,b', tgtType: 'list' })).toBe('L@a,b')
    expect(asCompound({ tgt: 'roles:db', tgtType: 'grain' })).toBe('G@roles:db')
    expect(asCompound({ tgt: '^web', tgtType: 'pcre' })).toBe('E@^web')
    expect(asCompound({ tgt: 'env:prod', tgtType: 'pillar' })).toBe('I@env:prod')
    expect(asCompound({ tgt: 'webservers', tgtType: 'nodegroup' })).toBe('N@webservers')
  })

  it('lists minions, sorted, as long as they fit', () => {
    expect(listTarget(['b', 'a'])).toEqual({ tgt: 'a,b', tgtType: 'list' })
    expect(listTarget([])).toBeNull()
    expect(listTarget(Array.from({ length: 300 }, (_, i) => `minion-${String(i).padStart(4, '0')}`))).toBeNull()
    expect('minion-0000,'.length * 300).toBeGreaterThan(MAX_TARGET)
  })
})

describe('the demo reads compound targets', () => {
  const sorted = (ids: string[]) => [...ids].sort()
  it('with and, or, not and parentheses', () => {
    expect(sorted(demoMatch('G@os:Ubuntu and G@osrelease:24.04', 'compound'))).toEqual(['web-01', 'web-02'])
    expect(sorted(demoMatch('db-* or L@mon-01', 'compound'))).toEqual(['db-01', 'mon-01'])
    expect(sorted(demoMatch('G@os:Ubuntu and not web-01', 'compound'))).toEqual(['web-02', 'worker-01'])
    expect(sorted(demoMatch('( web-* or G@os:Debian ) and G@roles:web', 'compound'))).toEqual(['web-01', 'web-02'])
    expect(sorted(demoMatch('G@roles:db or G@roles:cache and G@os:Debian', 'compound'))).toEqual(['cache-01', 'db-01'])
  })
})
