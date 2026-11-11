import { describe, expect, it } from 'vitest'
import { envDiff } from './envdiff'

const st = (id: string, result: boolean | null, extra: Record<string, unknown> = {}) => [`file_|-${id}_|-${id}_|-managed`, { __id__: id, __sls__: 'web', name: id, result, comment: 'c', changes: {}, ...extra }] as const
const run = (...states: ReturnType<typeof st>[]) => Object.fromEntries(states)

describe('envDiff', () => {
  it('keeps only what differs from base, worst first', () => {
    const base = run(st('motd', null, { changes: { diff: 'x' } }), st('nginx', true), st('ops', true), st('old', true))
    const branch = run(st('motd', null, { changes: { diff: 'x' } }), st('nginx', null, { changes: { diff: 'tls' } }), st('ops', false), st('tls.conf', null, { changes: { diff: 'new' } }))
    const d = envDiff(base, branch)
    expect('deltas' in d && d.deltas.map((x) => [x.id, x.kind])).toEqual([
      ['ops', 'fails'],
      ['nginx', 'changes'],
      ['tls.conf', 'new'],
      ['old', 'dropped'],
    ])
  })

  it('notes what base would change and the branch already settles', () => {
    const d = envDiff(run(st('motd', null, { changes: { diff: 'x' } })), run(st('motd', true)))
    expect('deltas' in d && d.deltas.map((x) => x.kind)).toEqual(['settles'])
  })

  it("says why when the branch doesn't render", () => {
    expect(envDiff(run(st('a', true)), ['Rendering SLS "nginx-tls:web" failed: mapping values are not allowed here'])).toEqual({ error: 'Rendering SLS "nginx-tls:web" failed: mapping values are not allowed here' })
  })
})
