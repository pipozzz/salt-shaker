import { describe, expect, it } from 'vitest'
import { SaltApi } from '../api/salt'
import type { Transport } from '../api/types'
import { fingersOf, noKeysPicked, pickKeys, type KeyFingers } from './keys'

// web-01 was reinstalled: its old key is still accepted, the new one is denied
const fingers: KeyFingers = {
  minions: { 'web-01': 'aa:aa', 'db-01': 'dd:dd' },
  minions_pre: { 'edge-01': 'ee:ee' },
  minions_rejected: { 'guest-01': '99:99' },
  minions_denied: { 'web-01': 'bb:bb' },
}

describe('fingersOf', () => {
  it("gives each card its own list's fingerprints for an id that is in two lists", () => {
    expect(fingersOf(fingers, 'minions')['web-01']).toBe('aa:aa')
    expect(fingersOf(fingers, 'minions_rejected', 'minions_denied')['web-01']).toBe('bb:bb')
  })
  it('leaves out ids from other lists', () => {
    expect(fingersOf(fingers, 'minions_pre')).toEqual({ 'edge-01': 'ee:ee' })
    expect(fingersOf(fingers, 'minions_rejected', 'minions_denied')).toEqual({ 'guest-01': '99:99', 'web-01': 'bb:bb' })
  })
  it('copes with no fingerprints, as when key.finger is not allowed', () => {
    expect(fingersOf({}, 'minions')).toEqual({})
    expect(fingersOf(undefined, 'minions', 'minions_denied')).toEqual({})
  })
})

describe('SaltApi.fingerprints', () => {
  it('keeps the lists apart as the master groups them', async () => {
    const transport = {
      call: async (low: Record<string, unknown>) => {
        expect(low).toMatchObject({ client: 'wheel', fun: 'key.finger', match: '*' })
        return { data: { return: fingers, success: true } }
      },
    } as unknown as Transport
    const got = await new SaltApi(transport, 'token', () => {}).fingerprints()
    expect(got.minions?.['web-01']).toBe('aa:aa')
    expect(got.minions_denied?.['web-01']).toBe('bb:bb')
  })
})

describe('pickKeys', () => {
  it('picks an id in one card only', () => {
    const picked = pickKeys(noKeysPicked(), 'refused', ['web-01'], true)
    expect([...picked.refused]).toEqual(['web-01'])
    expect(picked.accepted.has('web-01')).toBe(false)
    expect(picked.pending.has('web-01')).toBe(false)
  })
  it('unpicks in one card and leaves the same id picked in another', () => {
    let picked = pickKeys(noKeysPicked(), 'accepted', ['web-01', 'db-01'], true)
    picked = pickKeys(picked, 'refused', ['web-01'], true)
    picked = pickKeys(picked, 'refused', ['web-01'], false)
    expect(picked.refused.size).toBe(0)
    expect([...picked.accepted].sort()).toEqual(['db-01', 'web-01'])
  })
  it('does not change the set it was given', () => {
    const before = noKeysPicked()
    pickKeys(before, 'pending', ['edge-01'], true)
    expect(before.pending.size).toBe(0)
  })
})
