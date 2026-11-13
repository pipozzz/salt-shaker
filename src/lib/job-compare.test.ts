import { describe, expect, it } from 'vitest'
import { compareJobs, diffReturns, outcome, stateLabel } from './job-compare'

const st = (run: number, result: boolean | null, changes: Record<string, unknown> = {}, comment = '') => ({ __run_num__: run, result, changes, comment })
const PKG = 'pkg_|-nginx_|-nginx_|-installed'
const SVC = 'service_|-nginx_|-nginx_|-running'
const CONF = 'file_|-site_|-/etc/nginx/site.conf_|-managed'

describe('how a job ended on a minion', () => {
  it('reads states, text and plain values', () => {
    expect(outcome({ [PKG]: st(0, true) }, true, true)).toBe('ok')
    expect(outcome({ [PKG]: st(0, true, { nginx: { new: '1.24' } }) }, true, true)).toBe('changed')
    expect(outcome({ [PKG]: st(0, null) }, true, true)).toBe('pending')
    expect(outcome({ [PKG]: st(0, false) }, true, true)).toBe('failed')
    expect(outcome(true, true, true)).toBe('ok')
    expect(outcome('ERROR: nope', true, true)).toBe('failed')
    expect(outcome(undefined, false, true)).toBe('missing')
    expect(outcome(undefined, false, false)).toBe('absent')
  })

  it('names a state as its output does', () => {
    expect(stateLabel(PKG)).toBe('pkg.installed nginx')
    expect(stateLabel(CONF)).toBe('file.managed /etc/nginx/site.conf (site)')
  })
})

describe('what differs between two returns', () => {
  it('lists the states that ended differently, in the order they ran', () => {
    const a = { [PKG]: st(0, true), [CONF]: st(1, null, {}, 'would change'), [SVC]: st(2, true) }
    const b = { [SVC]: st(2, false, {}, 'nginx failed to start'), [CONF]: st(1, true, { diff: '+x' }, 'updated'), [PKG]: st(0, true) }
    const d = diffReturns(a, b)
    expect(d).toEqual({
      kind: 'states',
      same: 1,
      differ: [
        { key: CONF, label: 'file.managed /etc/nginx/site.conf (site)', a: 'pending', b: 'changed', aComment: 'would change', bComment: 'updated' },
        { key: SVC, label: 'service.running nginx', a: 'ok', b: 'failed', aComment: '', bComment: 'nginx failed to start' },
      ],
    })
  })

  it('shows a state only one of them has', () => {
    const d = diffReturns({ [PKG]: st(0, true) }, { [PKG]: st(0, true), [SVC]: st(1, true) })
    expect(d.kind === 'states' && d.differ.map((r) => [r.a, r.b])).toEqual([[null, 'ok']])
  })

  it('diffs text line by line, and values by key', () => {
    const t = diffReturns('Filesystem 10%\n/ 20%', 'Filesystem 10%\n/ 85%')
    expect(t.kind === 'text' && t.lines.filter((l) => l.kind !== 'same').map((l) => `${l.kind} ${l.text}`)).toEqual(['del / 20%', 'add / 85%'])
    expect(diffReturns('same', 'same')).toEqual({ kind: 'none' })
    const v = diffReturns({ nginx: '1.24', curl: '8.5' }, { nginx: '1.26', curl: '8.5' })
    expect(v).toEqual({ kind: 'values', same: 1, differ: [{ key: 'nginx', a: '1.24', b: '1.26' }] })
    expect(diffReturns(true, false)).toEqual({ kind: 'values', same: 0, differ: [{ key: 'value', a: 'true', b: 'false' }] })
  })
})

describe('two jobs, minion by minion', () => {
  it('puts the minions that differ first, and says who was in only one', () => {
    const rows = compareJobs(
      { minions: ['a', 'b', 'c'], results: { a: true, b: true } },
      { minions: ['a', 'b', 'd'], results: { a: true, b: false, d: true } },
    )
    expect(rows.map((r) => [r.id, r.a, r.b, r.differs])).toEqual([
      ['b', 'ok', 'failed', true],
      ['c', 'missing', 'absent', true],
      ['d', 'absent', 'ok', true],
      ['a', 'ok', 'ok', false],
    ])
  })
})
