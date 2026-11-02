import { describe, expect, it } from 'vitest'
import { minionOutcome } from './server'

describe('minionOutcome', () => {
  const base = { returnedAt: '2026-11-02T12:00:00Z', retcode: 0, success: true, summary: null, dryRun: false }
  const sum = (s: object) => JSON.stringify({ ok: 1, changed: 0, pending: 0, failed: 0, ...s })

  it('reads how a job ended on one minion', () => {
    expect(minionOutcome({ ...base, returnedAt: null })).toBe('noreturn')
    expect(minionOutcome(base)).toBe('ok')
    expect(minionOutcome({ ...base, retcode: 1 })).toBe('failed')
    expect(minionOutcome({ ...base, success: false })).toBe('failed')
    expect(minionOutcome({ ...base, summary: sum({ failed: 1, pending: 2 }) })).toBe('failed')
    expect(minionOutcome({ ...base, dryRun: true, summary: sum({ pending: 2 }) })).toBe('drift')
    expect(minionOutcome({ ...base, summary: sum({ changed: 3 }) })).toBe('changed')
    expect(minionOutcome({ ...base, summary: 'not json' })).toBe('ok')
  })
})
