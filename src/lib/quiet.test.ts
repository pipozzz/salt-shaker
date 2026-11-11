import { expect, it } from 'vitest'
import { quietMinions } from './quiet'

const DAY = 86400_000
const now = Date.UTC(2026, 10, 11)
const ago = (d: number) => new Date(now - d * DAY).toISOString()

it('lists accepted minions that are down and quiet for longer than the threshold', () => {
  const seen = { seen: { a: ago(0), b: ago(40), c: ago(10), d: ago(100) }, since: ago(200), checking: true }
  const accepted = ['a', 'b', 'c', 'd', 'e']
  // a answers; c is down but only for 10 days; e never answered since tracking began
  expect(quietMinions(accepted, ['b', 'c', 'd', 'e'], seen, 30, now)).toEqual([
    { id: 'e', lastSeen: null },
    { id: 'd', lastSeen: ago(100) },
    { id: 'b', lastSeen: ago(40) },
  ])
  expect(quietMinions(accepted, ['b', 'c', 'd', 'e'], seen, 7, now).map((q) => q.id)).toEqual(['e', 'd', 'b', 'c'])
  // a minion that answers is never listed, however old its record
  expect(quietMinions(['d'], [], seen, 30, now)).toEqual([])
})

it('does not call a never-seen minion quiet before tracking has run that long', () => {
  const seen = { seen: {}, since: ago(3), checking: true }
  expect(quietMinions(['x'], ['x'], seen, 30, now)).toEqual([])
  expect(quietMinions(['x'], ['x'], { seen: {}, since: null, checking: true }, 1, now)).toEqual([])
})
