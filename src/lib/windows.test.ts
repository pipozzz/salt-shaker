import { describe, expect, it } from 'vitest'
import { describeWindow, nextOpening, openingAt, readWindow, windowState, type MaintenanceWindow } from './windows'

// Tuesday and Thursday 22:00 in Bratislava, four hours: runs past midnight
const night: MaintenanceWindow = { id: 1, name: 'Nights', days: [2, 4], start: '22:00', minutes: 240, timezone: 'Europe/Bratislava' }
const iso = (d: { start: Date } | null) => d?.start.toISOString() ?? null

describe('maintenance windows', () => {
  it('is open from its local start for its length, past midnight too', () => {
    // 2026-11-10 is a Tuesday; Bratislava is UTC+1 in November
    expect(openingAt(night, Date.parse('2026-11-10T20:59:00Z'))).toBeNull()
    expect(iso(openingAt(night, Date.parse('2026-11-10T21:00:00Z')))).toBe('2026-11-10T21:00:00.000Z')
    expect(iso(openingAt(night, Date.parse('2026-11-11T00:30:00Z')))).toBe('2026-11-10T21:00:00.000Z')
    expect(openingAt(night, Date.parse('2026-11-11T01:00:00Z'))).toBeNull()
  })

  it('finds the next opening, in local time across a DST change', () => {
    expect(iso(nextOpening(night, Date.parse('2026-11-11T12:00:00Z')))).toBe('2026-11-12T21:00:00.000Z')
    expect(iso(nextOpening(night, Date.parse('2026-11-13T12:00:00Z')))).toBe('2026-11-17T21:00:00.000Z')
    // summer time (UTC+2) ends on 2026-10-25: the Tuesday before opens an hour earlier in UTC
    expect(iso(nextOpening(night, Date.parse('2026-10-19T12:00:00Z')))).toBe('2026-10-20T20:00:00.000Z')
    expect(iso(nextOpening(night, Date.parse('2026-10-26T12:00:00Z')))).toBe('2026-10-27T21:00:00.000Z')
  })

  it('across windows, says which is open or which opens first', () => {
    const sunday: MaintenanceWindow = { id: 2, name: 'Sunday', days: [0], start: '06:00', minutes: 120, timezone: 'UTC' }
    const at = Date.parse('2026-11-13T12:00:00Z') // Friday
    expect(windowState([night, sunday], at)).toMatchObject({ open: null, next: { window: { name: 'Sunday' } } })
    expect(windowState([night, sunday], Date.parse('2026-11-15T07:00:00Z'))).toMatchObject({ open: { window: { name: 'Sunday' } }, next: null })
    expect(windowState([], at)).toEqual({ open: null, next: null })
  })

  it('reads and describes what an admin enters', () => {
    expect(readWindow({ name: ' Nights ', days: [4, 2, 2], start: '9:05', minutes: 90, timezone: 'Europe/Bratislava' })).toEqual({ name: 'Nights', days: [2, 4], start: '09:05', minutes: 90, timezone: 'Europe/Bratislava' })
    expect(readWindow({ name: 'x', days: [], start: '22:00', minutes: 60, timezone: 'UTC' })).toEqual({ error: 'Pick at least one day' })
    expect(readWindow({ name: 'x', days: [1], start: '25:00', minutes: 60, timezone: 'UTC' })).toMatchObject({ error: expect.stringContaining('time') })
    expect(readWindow({ name: 'x', days: [1], start: '22:00', minutes: 5, timezone: 'UTC' })).toMatchObject({ error: expect.stringContaining('15 minutes') })
    expect(readWindow({ name: 'x', days: [1], start: '22:00', minutes: 60, timezone: 'Mars/Base' })).toMatchObject({ error: expect.stringContaining('timezone') })
    expect(describeWindow(night)).toBe('Tue, Thu 22:00 for 4 h (Europe/Bratislava)')
    expect(describeWindow({ days: [0, 1, 2, 3, 4, 5, 6], start: '01:00', minutes: 90, timezone: 'UTC' })).toBe('Every day 01:00 for 1 h 30 min (UTC)')
  })
})
