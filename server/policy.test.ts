import { describe, expect, it } from 'vitest'
import { authorize, jidOf } from './policy'

const ok = (d: ReturnType<typeof authorize>) => {
  if (!d.ok) throw new Error(`expected ok, got ${d.status}: ${d.reason}`)
  return d
}

describe('authorize', () => {
  it('rejects malformed input', () => {
    expect(authorize('admin', 'a', null)).toMatchObject({ ok: false, status: 400 })
    expect(authorize('admin', 'a', [{ client: 'local', fun: 'test.ping' }])).toMatchObject({ ok: false, status: 400 })
    expect(authorize('admin', 'a', { client: 'ssh', fun: 'test.ping' })).toMatchObject({ ok: false, status: 400 })
    expect(authorize('admin', 'a', { client: 'local', fun: 'test.ping; rm' })).toMatchObject({ ok: false, status: 400 })
  })

  it('applies role permissions per client', () => {
    expect(authorize('viewer', 'v', { client: 'local', fun: 'grains.items', tgt: '*' }).ok).toBe(true)
    expect(authorize('viewer', 'v', { client: 'local', fun: 'cmd.run', tgt: '*' })).toMatchObject({ ok: false, status: 403 })
    expect(authorize('viewer', 'v', { client: 'runner', fun: 'pillar.show_pillar' })).toMatchObject({ ok: false, status: 403 })
    expect(authorize('operator', 'o', { client: 'local', fun: 'cmd.run', tgt: '*' }).ok).toBe(true)
    expect(authorize('operator', 'o', { client: 'wheel', fun: 'key.accept', match: 'x' })).toMatchObject({ ok: false, status: 403 })
    expect(authorize('operator', 'o', { client: 'wheel', fun: 'file_roots.write' })).toMatchObject({ ok: false, status: 403 })
    expect(authorize('operator', 'o', { client: 'wheel', fun: 'file_roots.read' }).ok).toBe(true)
    expect(authorize('admin', 'a', { client: 'wheel', fun: 'key.delete', match: 'x' }).ok).toBe(true)
  })

  it('gives an unknown, missing or "none" role no permissions at all', () => {
    expect(authorize(null, 'x', { client: 'local', fun: 'test.ping' })).toMatchObject({ ok: false, status: 403 })
    expect(authorize('superuser', 'x', { client: 'local', fun: 'test.ping' })).toMatchObject({ ok: false, status: 403 })
    expect(authorize('none', 'x', { client: 'runner', fun: 'jobs.list_jobs' })).toMatchObject({ ok: false, status: 403 })
  })

  it('limits salt.cmd to test.version for non-admins', () => {
    expect(authorize('viewer', 'v', { client: 'runner', fun: 'salt.cmd', arg: ['test.version'] }).ok).toBe(true)
    expect(authorize('operator', 'o', { client: 'runner', fun: 'salt.cmd', arg: ['cmd.run', 'id'] })).toMatchObject({ ok: false, status: 403 })
    expect(authorize('operator', 'o', { client: 'runner', fun: 'salt.cmd', arg: ['test.version', 'extra'] })).toMatchObject({ ok: false, status: 403 })
    expect(authorize('admin', 'a', { client: 'runner', fun: 'salt.cmd', arg: ['cmd.run', 'id'] }).ok).toBe(true)
  })

  it('strips per-request credentials so users cannot swap the service account', () => {
    const d = ok(authorize('admin', 'a', { client: 'local', fun: 'test.ping', username: 'root', password: 'x', eauth: 'pam', token: 't' }))
    expect(d.low).not.toHaveProperty('username')
    expect(d.low).not.toHaveProperty('password')
    expect(d.low).not.toHaveProperty('eauth')
    expect(d.low).not.toHaveProperty('token')
  })

  it('tags local jobs with the real user, keeping existing metadata', () => {
    const d = ok(authorize('operator', 'otto', { client: 'local_async', fun: 'cmd.run', metadata: { ticket: 'OPS-1', salt_shaker_user: 'forged' } }))
    expect(d.low.metadata).toEqual({ ticket: 'OPS-1', salt_shaker_user: 'otto' })
    expect(ok(authorize('admin', 'a', { client: 'runner', fun: 'jobs.list_jobs' })).low).not.toHaveProperty('metadata')
  })

  it('audits changes but not reads', () => {
    expect(ok(authorize('admin', 'a', { client: 'local', fun: 'cmd.run' })).audited).toBe(true)
    expect(ok(authorize('admin', 'a', { client: 'local', fun: 'state.apply' })).audited).toBe(true)
    expect(ok(authorize('admin', 'a', { client: 'wheel', fun: 'key.accept' })).audited).toBe(true)
    expect(ok(authorize('admin', 'a', { client: 'runner', fun: 'state.orchestrate' })).audited).toBe(true)
    expect(ok(authorize('admin', 'a', { client: 'local', fun: 'grains.items' })).audited).toBe(false)
    expect(ok(authorize('admin', 'a', { client: 'runner', fun: 'jobs.lookup_jid' })).audited).toBe(false)
    expect(ok(authorize('admin', 'a', { client: 'wheel', fun: 'key.list_all' })).audited).toBe(false)
  })
})

describe('jidOf', () => {
  it('finds jids in async, runner_async and wheel replies', () => {
    expect(jidOf({ jid: '20261101184940076918', minions: ['web-01'] })).toBe('20261101184940076918')
    expect(jidOf({ tag: 'salt/wheel/1', data: { jid: '1', return: {} } })).toBe('1')
    expect(jidOf({ 'web-01': true })).toBeNull()
    expect(jidOf('')).toBeNull()
  })
})
