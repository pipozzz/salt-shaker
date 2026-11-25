import { describe, expect, it } from 'vitest'
import { jidOffset, jidTime, jobEvents, jobsAfter, MAX_CATCH_UP } from './catchup'
import { parseJobEvent, worthRecording } from './history'

describe('catching up on missed jobs', () => {
  it('reads the time in a jid and how far the master is from UTC', () => {
    expect(jidTime('20261125092703685122')).toBe(Date.UTC(2026, 10, 25, 9, 27, 3, 685))
    expect(jidTime('not-a-jid')).toBeNull()
    expect(jidOffset('20261125102703685122', new Date('2026-11-25T09:27:04.001Z'))).toBe(3600_000)
    expect(jidOffset('20261125042703685122', new Date('2026-11-25T09:27:03.900Z'))).toBe(-5 * 3600_000)
    expect(jidOffset('20261125092703685122', new Date('2026-11-25T09:27:03.700Z'))).toBe(0)
  })

  it('picks the newer jobs worth recording, oldest first and at most the newest few hundred', () => {
    const listed = {
      '20261125090000000003': { Function: 'cmd.run' },
      '20261125090000000001': { Function: 'state.apply' },
      '20261125090000000002': { Function: 'test.ping' },
      '20261125090000000004': { Function: 'test.ping', Metadata: { salt_shaker_user: 'schedule:ping' } },
      '20261125090000000005': { Function: 'runner.jobs.list_jobs' },
      '20261125080000000000': { Function: 'cmd.run' },
      '': { Function: 'cmd.run' },
    }
    expect(jobsAfter(listed, '20261125085959999999', worthRecording)).toEqual({ jids: ['20261125090000000001', '20261125090000000003', '20261125090000000004'], skipped: 0 })
    const many = Object.fromEntries(Array.from({ length: MAX_CATCH_UP + 5 }, (_, i) => [`2026112509${String(i).padStart(10, '0')}`, { Function: 'cmd.run' }]))
    const { jids, skipped } = jobsAfter(many, '0', worthRecording)
    expect(skipped).toBe(5)
    expect(jids[0]).toBe('20261125090000000005')
  })

  it('turns a job from the job cache into the events the bus would have carried', () => {
    const jid = '20261125102703685122'
    const events = jobEvents(jid, { Function: 'cmd.run', Arguments: ['echo hi'], Target: 'web-*', 'Target-type': 'glob', User: 'root', Minions: ['web-01', 'web-02'], Result: { 'web-01': { return: 'hi', retcode: 0, success: true } } }, 3600_000)
    expect(events.map(([tag]) => tag)).toEqual([`salt/job/${jid}/new`, `salt/job/${jid}/ret/web-01`])
    const [first, second] = events.map(([tag, data]) => parseJobEvent(tag, data))
    expect(first).toMatchObject({ kind: 'new', job: { jid, fun: 'cmd.run', target: 'web-*', targetType: 'glob', saltUser: 'root', minions: '["web-01","web-02"]', startedAt: new Date('2026-11-25T09:27:03.685Z') } })
    expect(second).toMatchObject({ kind: 'ret', ret: { jid, minion: 'web-01', ret: '"hi"', retcode: 0, success: true, returnedAt: new Date('2026-11-25T09:27:03.685Z') } })
  })
})
