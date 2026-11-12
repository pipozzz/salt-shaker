import { expect, it } from 'vitest'
import type { VulnMinion } from '../api/server'
import { complianceCounts, signed, topVulnerable } from './fleet-report'

it('splits compliance, with the share and who needs a look (errors first)', () => {
  const c = complianceCounts({ 'web-10': { status: 'ok' }, 'web-2': { status: 'drift' }, db: { status: 'error' }, cache: { status: 'ok' } }, 6)
  expect(c).toEqual({ ok: 2, drift: 1, error: 1, unchecked: 2, percent: 50, attention: ['db', 'web-2'], more: 0 })
  expect(complianceCounts({}, 3)).toMatchObject({ percent: null, unchecked: 3 })
  const many = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`m${i}`, { status: 'drift' as const }]))
  expect(complianceCounts(many, 15)).toMatchObject({ attention: expect.any(Array), more: 3 })
})

it('ranks minions by critical, then high, and leaves out the clean ones', () => {
  const m = (minion: string, critical: number, high: number) => ({ minion, counts: { critical, high } }) as VulnMinion
  expect(topVulnerable([m('a', 0, 5), m('b', 2, 0), m('c', 0, 0), m('d', 2, 3)], 10).map((x) => x.minion)).toEqual(['d', 'b', 'a'])
  expect(topVulnerable([m('a', 1, 0), m('b', 2, 0)], 1).map((x) => x.minion)).toEqual(['b'])
})

it('says how a number moved since last week', () => {
  expect(signed(3, 4)).toBe('−1 since last week')
  expect(signed(5, 3)).toBe('+2 since last week')
  expect(signed(3, 3)).toBe('same as last week')
  expect(signed(3, null)).toBe('no week-old scan to compare')
})
