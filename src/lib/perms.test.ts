import { describe, expect, it } from 'vitest'
import { makeCan } from './perms'

// the exact perms salt-api returned at login for the lab's "viewer" user
const viewer = makeCan([
  'grains.*',
  'pkg.list_upgrades',
  'pkg.version',
  'saltutil.find_job',
  'sys.list_functions',
  'test.ping',
  { '@runner': ['manage.status', 'cache.grains', 'jobs.*', 'pillar.show_pillar'] },
  { '@wheel': ['key.list_all', 'key.finger', 'file_roots.*', 'pillar_roots.*'] },
])

describe('makeCan', () => {
  it('matches local functions by regex', () => {
    expect(viewer('local', 'grains.items')).toBe(true)
    expect(viewer('local', 'test.ping')).toBe(true)
    expect(viewer('local', 'cmd.run')).toBe(false)
    expect(viewer('local', 'pkg.install')).toBe(false)
  })

  it('anchors patterns so prefixes do not leak', () => {
    expect(viewer('local', 'test.pingx')).toBe(false)
    expect(viewer('local', 'xgrains.items')).toBe(false)
  })

  it('scopes runner and wheel functions to their @groups', () => {
    expect(viewer('runner', 'jobs.list_jobs')).toBe(true)
    expect(viewer('runner', 'state.orchestrate')).toBe(false)
    expect(viewer('wheel', 'key.list_all')).toBe(true)
    expect(viewer('wheel', 'key.accept')).toBe(false)
    // a local perm must not grant the same name on another client
    expect(viewer('runner', 'test.ping')).toBe(false)
  })

  it('treats bare @wheel/@runner as everything in that client', () => {
    const admin = makeCan(['.*', '@wheel', '@runner', '@jobs'])
    expect(admin('local', 'cmd.run')).toBe(true)
    expect(admin('wheel', 'key.delete')).toBe(true)
    expect(admin('runner', 'state.orchestrate')).toBe(true)
  })

  it('lets @jobs grant only the jobs runners', () => {
    const jobsOnly = makeCan(['@jobs'])
    expect(jobsOnly('runner', 'jobs.lookup_jid')).toBe(true)
    expect(jobsOnly('runner', 'manage.status')).toBe(false)
  })

  it('understands target-scoped and argument-constrained entries', () => {
    const can = makeCan([{ 'web*': ['state.apply', { 'service.restart': { args: ['nginx'] } }] }])
    expect(can('local', 'state.apply')).toBe(true)
    expect(can('local', 'service.restart')).toBe(true)
    expect(can('local', 'cmd.run')).toBe(false)
  })

  it('allows everything when the master reported no perms', () => {
    expect(makeCan(undefined)('wheel', 'key.delete')).toBe(true)
  })
})
