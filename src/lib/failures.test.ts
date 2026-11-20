import { describe, expect, it } from 'vitest'
import { failureGroups, normalizeMessage, rerunArgs, runSls, stateName, type RunReturn } from './failures'

const SVC = 'service_|-nginx_|-nginx_|-running'
const PKG = 'pkg_|-nginx_|-nginx_|-installed'
const st = (run: number, result: boolean | null, comment = '', sls = 'webserver') => ({ __run_num__: run, __sls__: sls, result, comment, changes: {} })
let n = 0
const ret = (minion: string, at: number, r: unknown, fun = 'state.apply', args: unknown[] = [], dryRun = false): RunReturn => ({
  jid: `j${++n}`,
  fun,
  args: JSON.stringify(args),
  dryRun,
  minion,
  ret: r,
  at,
})

describe('reading a state run', () => {
  it('finds the SLS it applied, in any order, and none for the highstate', () => {
    expect(runSls('state.apply', JSON.stringify([]))).toBe('')
    expect(runSls('state.apply', JSON.stringify(['webserver, common', { __kwarg__: true, test: true }]))).toBe('common,webserver')
    expect(runSls('state.sls', JSON.stringify([{ __kwarg__: true, mods: 'postgres' }]))).toBe('postgres')
    expect(runSls('state.apply', JSON.stringify(['test=True']))).toBe('')
    expect(runSls('state.highstate', JSON.stringify(['ignored']))).toBe('')
    expect(runSls('state.apply', 'not json')).toBe('')
  })

  it('names a state as its output does', () => {
    expect(stateName(SVC)).toBe('service.running nginx')
  })

  it('takes out what differs between minions', () => {
    expect(normalizeMessage('\n----------\nFailed to fetch http://10.0.3.7/repo for web-01 (pid 48213)\nmore', 'web-01')).toBe('Failed to fetch http://<ip>/repo for <minion> (pid N)')
    expect(normalizeMessage('x'.repeat(400), 'a')).toHaveLength(300)
  })

  it('runs it again on the SLS, as a dry run if asked', () => {
    expect(rerunArgs({ sls: 'webserver' })).toBe('webserver')
    expect(rerunArgs({ sls: null }, true)).toBe('test=True')
  })
})

describe('failures across the fleet', () => {
  it('groups the same failure on several minions, the most widespread first', () => {
    const groups = failureGroups([
      ret('web-02', 100, { [PKG]: st(0, true), [SVC]: st(1, false, 'Job for nginx.service failed on web-02.') }),
      ret('web-10', 110, { [PKG]: st(0, true), [SVC]: st(1, false, 'Job for nginx.service failed on web-10.') }),
      ret('db-01', 120, { 'pkg_|-pg_|-postgresql_|-installed': st(0, false, 'No such package', 'postgres') }),
    ])
    expect(groups.map((g) => [g.kind, g.label, g.message, g.minions.map((m) => m.id), g.sls])).toEqual([
      ['state', 'service.running nginx', 'Job for nginx.service failed on <minion>.', ['web-02', 'web-10'], 'webserver'],
      ['state', 'pkg.installed postgresql', 'No such package', ['db-01'], 'postgres'],
    ])
    expect(groups[0].minions[1]).toMatchObject({ comment: 'Job for nginx.service failed on web-10.', at: 110 })
    expect(groups[0].lastSeen).toBe(110)
  })

  it('forgets a failed state once a later run has it succeed, whatever ran it', () => {
    const groups = failureGroups([
      ret('web-02', 100, { [SVC]: st(1, false, 'down') }),
      ret('web-02', 200, { [SVC]: st(0, true) }, 'state.sls', ['webserver']),
      ret('web-03', 100, { [SVC]: st(1, false, 'down') }),
      // a later run that didn't have the state leaves it failing
      ret('web-03', 200, { 'file_|-motd_|-/etc/motd_|-managed': st(0, true, '', 'common') }, 'state.apply', ['common']),
      // and a later failure replaces the earlier message
      ret('web-04', 100, { [SVC]: st(1, false, 'old') }),
      ret('web-04', 200, { [SVC]: st(1, false, 'new') }),
    ])
    expect(groups.map((g) => `${g.message}: ${g.minions.map((m) => m.id).join(',')}`)).toEqual(['new: web-04', 'down: web-03'])
  })

  it('counts a run that never got to its states until it, or a highstate, gets through', () => {
    const missing = ["No matching sls found for 'webserver.tls' in env 'base'"]
    const groups = failureGroups([
      ret('web-01', 100, missing, 'state.apply', ['webserver.tls']),
      ret('web-02', 100, missing, 'state.apply', ['webserver.tls']),
      // fixed by the same run
      ret('web-03', 100, missing, 'state.apply', ['webserver.tls']),
      ret('web-03', 200, { [SVC]: st(0, true) }, 'state.apply', ['webserver.tls']),
      // by a highstate that got through
      ret('web-04', 100, missing, 'state.apply', ['webserver.tls']),
      ret('web-04', 200, { [SVC]: st(0, true) }),
      // a different SLS doesn't fix it
      ret('web-02', 200, { [SVC]: st(0, true) }, 'state.apply', ['common']),
      // a render error of the highstate itself
      ret('mon-01', 50, ["Rendering SLS 'base:monitoring' failed: Jinja variable 'dict object' has no attribute 'grafana_port'"], 'state.highstate', [], true),
    ])
    expect(groups.map((g) => [g.kind, g.label, g.sls, g.minions.map((m) => m.id)])).toEqual([
      ['run', 'state.apply webserver.tls', 'webserver.tls', ['web-01', 'web-02']],
      ['run', 'state.highstate', null, ['mon-01']],
    ])
    expect(groups[1].minions[0].dryRun).toBe(true)
  })

  it('has nothing to say when everything worked', () => {
    expect(failureGroups([ret('a', 1, { [SVC]: st(0, true) }), ret('b', 1, { [SVC]: st(0, null) }, 'state.apply', [], true)])).toEqual([])
  })
})
