import { describe, expect, it } from 'vitest'
import { parseSaltStamp } from './stamp'

describe('parseSaltStamp', () => {
  it('reads stamps with and without a zone as UTC', () => {
    expect(parseSaltStamp('2026-11-18T12:49:14.123456')?.toISOString()).toBe('2026-11-18T12:49:14.123Z')
    expect(parseSaltStamp('2026-11-18T12:49:14.123456+00:00')?.toISOString()).toBe('2026-11-18T12:49:14.123Z')
    expect(parseSaltStamp('2026-11-18T12:49:14.123456Z')?.toISOString()).toBe('2026-11-18T12:49:14.123Z')
    expect(parseSaltStamp('2026-11-18T13:49:14+01:00')?.toISOString()).toBe('2026-11-18T12:49:14.000Z')
  })
  it('gives null for anything else', () => {
    for (const s of [undefined, null, 42, '', 'yesterday']) expect(parseSaltStamp(s)).toBeNull()
  })
})
