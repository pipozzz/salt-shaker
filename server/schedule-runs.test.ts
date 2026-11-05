import { afterEach, describe, expect, it } from 'vitest'
import { recentScheduleRuns, runStatus } from './schedule-runs'
import { openTestDatabase, testDialects } from './testdb'

const state = (s: Partial<{ ok: number; changed: number; pending: number; failed: number }>) => JSON.stringify({ ok: 1, changed: 0, pending: 0, failed: 0, ...s })
const ret = (minion: string, o: Partial<{ retcode: number; success: boolean; summary: string; ret: string }> = {}) => ({
  minion,
  retcode: o.retcode ?? 0,
  success: o.success ?? true,
  summary: o.summary ?? null,
  ret: o.ret ?? null,
})

describe('runStatus', () => {
  it('buckets compliance checks like the Compliance page', () => {
    expect(runStatus('compliance', [ret('a', { summary: state({}) }), ret('b', { summary: state({}) })], 2, false)).toEqual({ status: 'ok', detail: '2 ok · 0 drifted · 0 errors' })
    expect(runStatus('compliance', [ret('a', { summary: state({ pending: 2 }) }), ret('b', { summary: state({}) })], 2, false).status).toBe('changed')
    expect(runStatus('compliance', [ret('a', { summary: state({ failed: 1 }) }), ret('b', { summary: state({ pending: 1 }) })], 2, false)).toEqual({ status: 'failed', detail: '0 ok · 1 drifted · 1 error' })
  })

  it('tells patch scans with updates from clean ones', () => {
    expect(runStatus('patches', [ret('a', { ret: '{"curl":"8.1"}' }), ret('b', { ret: '{}' })], 2, false)).toEqual({ status: 'changed', detail: '1 minion with 1 package to update' })
    expect(runStatus('patches', [ret('a', { ret: '{}' })], 1, false)).toEqual({ status: 'ok', detail: '1 minion up to date' })
  })

  it('marks missing returns as running while recent, and as no return afterwards', () => {
    const rows = [ret('a')]
    expect(runStatus('function', rows, 3, true)).toEqual({ status: 'running', detail: '1 of 3 returned so far' })
    expect(runStatus('function', rows, 3, false)).toEqual({ status: 'noreturn', detail: '1 ok · 0 failed · 2 no return' })
    // a failure outranks the missing minions
    expect(runStatus('function', [ret('a', { retcode: 1 })], 2, false)).toEqual({ status: 'failed', detail: '0 ok · 1 failed · 1 no return' })
  })
})

describe.each(testDialects)('recentScheduleRuns (%s)', (dialect) => {
  let close: (() => Promise<unknown>) | null = null
  afterEach(async () => {
    await close?.()
    close = null
  })
  const at = (h: number) => new Date(Date.UTC(2026, 10, 5, h))

  it("lists each schedule's latest runs, oldest first, with their status", async () => {
    const opened = await openTestDatabase(dialect)
    close = opened.close
    const { db, schema } = opened
    await db.insert(schema.job).values([
      { jid: '1', fun: 'state.apply', dryRun: true, shakerUser: 'schedule:nightly', minions: '["a","b"]', startedAt: at(1) },
      { jid: '2', fun: 'state.apply', dryRun: true, shakerUser: 'schedule:nightly', minions: '["a","b"]', startedAt: at(2) },
      { jid: '3', fun: 'state.apply', dryRun: true, shakerUser: 'schedule:nightly', minions: '["a","b"]', startedAt: at(3) },
      // another schedule whose name starts the same, and a job a person ran
      { jid: '4', fun: 'test.ping', shakerUser: 'schedule:nightly-2', minions: '["a"]', startedAt: at(4) },
      { jid: '5', fun: 'state.apply', shakerUser: 'alice', minions: '["a"]', startedAt: at(5) },
    ])
    await db.insert(schema.jobReturn).values([
      { jid: '1', minion: 'a', summary: state({}), retcode: 0, success: true, returnedAt: at(1) },
      { jid: '1', minion: 'b', summary: state({}), retcode: 0, success: true, returnedAt: at(1) },
      { jid: '2', minion: 'a', summary: state({ failed: 1 }), retcode: 2, success: true, returnedAt: at(2) },
      { jid: '2', minion: 'b', summary: state({}), retcode: 0, success: true, returnedAt: at(2) },
      { jid: '3', minion: 'a', summary: state({}), retcode: 0, success: true, returnedAt: at(3) },
      { jid: '4', minion: 'a', retcode: 0, success: true, returnedAt: at(4) },
    ])
    const runs = await recentScheduleRuns(db, schema, [
      { name: 'nightly', kind: 'compliance' },
      { name: 'never', kind: 'function' },
    ], { limit: 2, now: new Date(at(3).getTime() + 5 * 60_000) })
    expect(runs.get('nightly')).toEqual([
      { jid: '2', startedAt: at(2), status: 'failed', detail: '1 ok · 0 drifted · 1 error' },
      { jid: '3', startedAt: at(3), status: 'running', detail: '1 of 2 returned so far' },
    ])
    expect(runs.get('never')).toEqual([])
  })
})
