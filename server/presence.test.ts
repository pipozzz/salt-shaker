import { describe, expect, it } from 'vitest'
import type { Notifier } from './notify'
import { PresenceWatcher } from './presence'
import type { SaltService } from './salt'

function watcher(answers: Array<{ up: string[]; down: string[] } | Error>) {
  const sent: string[] = []
  const notifier = { emit: async (event: string, msg: { title: string }) => void sent.push(`${event}: ${msg.title}`) } as unknown as Notifier
  const salt = {
    call: async () => {
      const a = answers.shift()
      if (a instanceof Error) throw a
      return a
    },
  } as unknown as SaltService
  return { w: new PresenceWatcher(salt, notifier, 60_000), sent }
}

describe('PresenceWatcher', () => {
  it('reports a minion after two missed checks, once, and again when it is back', async () => {
    const { w, sent } = watcher([
      { up: ['a', 'b'], down: [] },
      { up: ['a'], down: ['b'] },
      { up: ['a'], down: ['b'] },
      { up: ['a'], down: ['b'] },
      { up: ['a', 'b'], down: [] },
    ])
    await w.check()
    await w.check()
    expect(sent).toEqual([])
    await w.check()
    expect(sent).toEqual(['minion_down: Minion stopped responding: b'])
    await w.check()
    expect(sent).toHaveLength(1)
    await w.check()
    expect(sent).toEqual(['minion_down: Minion stopped responding: b', 'minion_down: Minion is responding again: b'])
  })

  it('takes minions already down at start as the baseline', async () => {
    const { w, sent } = watcher([
      { up: ['a'], down: ['old'] },
      { up: ['a'], down: ['old'] },
      { up: ['a'], down: ['old'] },
      { up: ['a', 'old'], down: [] },
    ])
    for (let i = 0; i < 3; i++) await w.check()
    expect(sent).toEqual([])
    // it comes back: worth knowing, since it was down
    await w.check()
    expect(sent).toEqual(['minion_down: Minion is responding again: old'])
  })

  it('ignores a single miss, unanswered checks and deleted keys, and groups minions', async () => {
    const { w, sent } = watcher([
      { up: ['a', 'b', 'c', 'd'], down: [] },
      { up: ['b', 'c', 'd'], down: ['a'] },
      { up: ['a', 'b', 'c', 'd'], down: [] },
      new Error('salt-api down'),
      { up: ['a'], down: ['b', 'c'] },
      { up: ['a'], down: ['b', 'c'] },
    ])
    for (let i = 0; i < 4; i++) await w.check()
    expect(sent).toEqual([])
    await w.check()
    await w.check()
    // d's key was deleted: not down, just gone
    expect(sent).toEqual(['minion_down: 2 minions stopped responding'])
  })
})

it('passes the minions that answered to onSeen', async () => {
  const seen: string[][] = []
  const salt = { call: async () => ({ up: ['a'], down: ['b'] }) } as unknown as SaltService
  const notifier = { emit: async () => undefined } as unknown as Notifier
  await new PresenceWatcher(salt, notifier, 60_000, 2, async (up) => void seen.push(up)).check()
  expect(seen).toEqual([['a']])
})
