import { describe, expect, it } from 'vitest'
import { narrowRead, pick, refuseRead, visibleEvent, visibleList } from './visible'

const v = new Set(['web-01', 'web-02'])
const noJobs = async () => new Map<string, string[]>()

describe('what a scoped user sees', () => {
  it('picks their minions from records and lists', () => {
    expect(pick(v, { 'web-01': 1, 'db-01': 2 })).toEqual({ 'web-01': 1 })
    expect(pick(null, { 'db-01': 2 })).toEqual({ 'db-01': 2 })
    expect(visibleList(v, '["web-01","db-01"]')).toEqual(['web-01'])
    expect(visibleList(v, null)).toBeNull()
  })

  it('passes the events about their minions, narrows new jobs, and drops the rest', () => {
    expect(visibleEvent(v, 'salt/job/1/new', { minions: ['web-01', 'web-02'] })).toBe('same')
    expect(visibleEvent(v, 'salt/job/1/new', { fun: 'test.ping', minions: ['web-01', 'db-01'] })).toEqual({ fun: 'test.ping', minions: ['web-01'] })
    expect(visibleEvent(v, 'salt/job/1/new', { minions: ['db-01'] })).toBeNull()
    expect(visibleEvent(v, 'salt/job/1/ret/web-02', { id: 'web-02' })).toBe('same')
    expect(visibleEvent(v, 'salt/job/1/ret/db-01', { id: 'db-01' })).toBeNull()
    expect(visibleEvent(v, 'salt/job/1/prog/db-01/0', {})).toBeNull()
    expect(visibleEvent(v, 'salt/minion/web-01/start', { id: 'web-01' })).toBe('same')
    expect(visibleEvent(v, 'salt/key', { id: 'db-01', act: 'accept' })).toBeNull()
    expect(visibleEvent(v, 'salt/presence/present', { present: ['web-01', 'db-01'] })).toEqual({ present: ['web-01'] })
    // runner jobs answer for the whole fleet, and the master's own events name no minion
    expect(visibleEvent(v, 'salt/run/2/ret', { id: 'master_master', return: { up: ['db-01'] } })).toBeNull()
    expect(visibleEvent(v, 'salt/auth', { id: 'db-01' })).toBeNull()
  })

  it('refuses reads that would show the whole fleet, and pillar of other minions', () => {
    expect(refuseRead(v, { client: 'runner', fun: 'manage.status' })).toBeNull()
    expect(refuseRead(v, { client: 'runner', fun: 'fileserver.file_list' })).toBeNull()
    expect(refuseRead(v, { client: 'wheel', fun: 'file_roots.read' })).toBeNull()
    expect(refuseRead(v, { client: 'runner', fun: 'pillar.show_pillar', minion: 'web-01' })).toBeNull()
    expect(refuseRead(v, { client: 'runner', fun: 'pillar.show_pillar', kwarg: { minion: 'web-02' } })).toBeNull()
    expect(refuseRead(v, { client: 'runner', fun: 'pillar.show_pillar', minion: 'db-01' })).toMatch(/Outside your access: db-01/)
    expect(refuseRead(v, { client: 'runner', fun: 'pillar.show_pillar' })).toMatch(/master's pillar/)
    expect(refuseRead(v, { client: 'runner', fun: 'jobs.print_job' })).toMatch(/whole fleet/)
  })

  it('narrows what the master answers about minions, without changing the shared answer', async () => {
    const status = { up: ['web-01', 'db-01'], down: ['web-02', 'db-02'] }
    expect(await narrowRead(v, { fun: 'manage.status' }, status, noJobs)).toEqual({ up: ['web-01'], down: ['web-02'] })
    expect(status.up).toEqual(['web-01', 'db-01'])
    expect(await narrowRead(v, { fun: 'manage.versions' }, { 'Up to date': { 'web-01': '3007', 'db-01': '3007' }, Master: '3007' }, noJobs)).toEqual({ 'Up to date': { 'web-01': '3007' }, Master: '3007' })
    expect(await narrowRead(v, { fun: 'cache.grains' }, { 'web-01': { os: 'Debian' }, 'db-01': {} }, noJobs)).toEqual({ 'web-01': { os: 'Debian' } })
    expect(await narrowRead(v, { fun: 'jobs.lookup_jid' }, { outputter: 'highstate', data: { 'web-02': 1, 'db-01': 2 } }, noJobs)).toEqual({ outputter: 'highstate', data: { 'web-02': 1 } })
    expect(await narrowRead(v, { fun: 'jobs.list_job' }, { Function: 'cmd.run', Minions: ['web-01', 'db-01'], Result: { 'db-01': {} } }, noJobs)).toEqual({ Function: 'cmd.run', Minions: ['web-01'], Result: {} })
    // a job on none of theirs looks like one the master doesn't keep
    expect(await narrowRead(v, { fun: 'jobs.list_job' }, { Function: 'cmd.run', Minions: ['db-01'], Result: { 'db-01': {} } }, noJobs)).toEqual({})
    const active = { '1': { Running: [{ 'web-01': 12 }, { 'db-01': 13 }], Returned: ['db-02'] }, '2': { Running: [{ 'db-01': 14 }], Returned: [] } }
    expect(await narrowRead(v, { fun: 'jobs.active' }, active, noJobs)).toEqual({ '1': { Running: [{ 'web-01': 12 }], Returned: [] } })
    const keys = { tag: 'k', data: { success: true, return: { minions: ['web-01', 'db-01'], minions_pre: ['new-01'], minions_rejected: [], minions_denied: [], local: ['master.pem'] } } }
    expect(await narrowRead(v, { fun: 'key.list_all' }, keys, noJobs)).toEqual({ tag: 'k', data: { success: true, return: { minions: ['web-01'], minions_pre: [], minions_rejected: [], minions_denied: [], local: ['master.pem'] } } })
    const fingers = { tag: 'k', data: { return: { minions: { 'web-01': 'aa', 'db-01': 'bb' }, local: { 'master.pub': 'cc' } } } }
    expect(await narrowRead(v, { fun: 'key.finger' }, fingers, noJobs)).toEqual({ tag: 'k', data: { return: { minions: { 'web-01': 'aa' }, local: { 'master.pub': 'cc' } } } })
  })

  it('keeps the jobs the master lists that ran on any of their minions, as recorded', async () => {
    const jobs = { '1': { Function: 'cmd.run' }, '2': { Function: 'state.apply' }, '3': { Function: 'test.ping' } }
    const where = async (jids: string[]) => {
      expect(jids).toEqual(['1', '2', '3'])
      return new Map([
        ['1', ['db-01', 'web-02']],
        ['2', ['db-01']],
      ])
    }
    expect(await narrowRead(v, { fun: 'jobs.list_jobs' }, jobs, where)).toEqual({ '1': { Function: 'cmd.run' } })
  })
})
