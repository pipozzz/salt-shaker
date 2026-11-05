import { describe, expect, it } from 'vitest'
import { canonical, groupByOutput } from './group'

describe('groupByOutput', () => {
  it('groups minions with the same output, biggest group first', () => {
    const groups = groupByOutput({ 'web-02': '3.0.13', 'db-01': '3.0.2', 'web-01': '3.0.13', 'cache-01': '3.0.13' })
    expect(groups?.map((g) => [g.ret, g.ids])).toEqual([
      ['3.0.13', ['cache-01', 'web-01', 'web-02']],
      ['3.0.2', ['db-01']],
    ])
  })

  it('treats objects with the same content in another key order as equal', () => {
    expect(canonical({ b: 1, a: [{ y: 2, x: 1 }] })).toBe(canonical({ a: [{ x: 1, y: 2 }], b: 1 }))
    expect(groupByOutput({ a: { os: 'Debian', v: 12 }, b: { v: 12, os: 'Debian' }, c: { os: 'Rocky', v: 9 } })?.[0].ids).toEqual(['a', 'b'])
  })

  it('puts failed outputs before other groups of the same size', () => {
    const groups = groupByOutput({ a: 'ok', b: 'ok', c: "'nope' is not available.", d: "'nope' is not available." })
    expect(groups?.map((g) => [g.ids, g.failed])).toEqual([
      [['c', 'd'], true],
      [['a', 'b'], false],
    ])
  })

  it("doesn't group state runs, single minions or all-different outputs", () => {
    const state = { 'pkg_|-curl_|-curl_|-installed': { result: true, changes: {}, comment: '', name: 'curl', __id__: 'curl', duration: 1 } }
    expect(groupByOutput({ a: state, b: state })).toBeNull()
    expect(groupByOutput({ a: 'x' })).toBeNull()
    expect(groupByOutput({ a: 'x', b: 'y' })).toBeNull()
  })
})
