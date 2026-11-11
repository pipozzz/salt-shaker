import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { scopeRoutes } from './routes/scopes'
import { cachedExpand, checkScope, loadScope, type Expand } from './scope'
import { openTestDatabase, testDialects } from './testdb'
import type { Env } from './types'

// what the grains cache would match
const FLEET: Record<string, string[]> = {
  'glob:*': ['db-01', 'db-02', 'web-01'],
  'glob:db-*': ['db-01', 'db-02'],
  'compound:G@roles:db': ['db-01', 'db-02'],
  'glob:db-01': ['db-01'],
  'glob:web-*': ['web-01'],
  'list:db-01,web-01': ['db-01', 'web-01'],
}
const expand: Expand = async (tgt, type) => FLEET[`${type}:${tgt}`] ?? []
const scope = { target: 'G@roles:db', targetType: 'compound' }

describe('checkScope', () => {
  it('lets a call through on minions in scope, narrowed to exactly them', async () => {
    expect(await checkScope(scope, { client: 'local_async', fun: 'state.apply', tgt: 'db-*', tgt_type: 'glob' }, expand)).toEqual({
      ok: true,
      low: { client: 'local_async', fun: 'state.apply', tgt: 'db-01,db-02', tgt_type: 'list' },
    })
  })

  it('refuses a target that reaches beyond it, naming the minions', async () => {
    expect(await checkScope(scope, { client: 'local', fun: 'cmd.run', tgt: '*', tgt_type: 'glob' }, expand)).toEqual({ ok: false, reason: 'Outside your access (compound:G@roles:db): web-01' })
    expect(await checkScope(scope, { client: 'local', fun: 'cmd.run', tgt: 'db-01,web-01', tgt_type: 'list' }, expand)).toMatchObject({ ok: false })
    expect(await checkScope(scope, { client: 'local', fun: 'test.ping', tgt: 'nope-*', tgt_type: 'glob' }, expand)).toEqual({ ok: false, reason: 'No minion in your access (compound:G@roles:db) matches nope-*' })
  })

  it('allows reading runners, not ones that change something', async () => {
    expect(await checkScope(scope, { client: 'runner', fun: 'manage.status' }, expand)).toMatchObject({ ok: true })
    expect(await checkScope(scope, { client: 'runner', fun: 'state.orchestrate', arg: ['orch.deploy'] }, expand)).toEqual({ ok: false, reason: 'Your access is limited to compound:G@roles:db; runner state.orchestrate runs outside any target' })
    expect(await checkScope(scope, { client: 'wheel', fun: 'key.accept' }, expand)).toMatchObject({ ok: false })
  })

  it('asks the master once for the same target within a short while', async () => {
    let calls = 0
    const cached = cachedExpand(async (t, ty) => (calls++, expand(t, ty)))
    await cached('db-*', 'glob')
    await cached('db-*', 'glob')
    expect(calls).toBe(1)
  })
})

describe.each(testDialects)('scope admin API (%s)', (dialect) => {
  let close: (() => Promise<unknown>) | null = null
  afterEach(async () => {
    await close?.()
    close = null
  })

  it('lets admins limit a user, and audits it', async () => {
    const opened = await openTestDatabase(dialect)
    close = opened.close
    const { db, schema } = opened
    await db.insert(schema.user).values({ id: 'u-olga', name: 'Olga', email: 'olga@x.invalid', username: 'olga', role: 'operator', createdAt: new Date(), updatedAt: new Date() })
    const audited: string[] = []
    const app = new Hono<Env>()
    app.use('*', async (c, next) => {
      const [name, role] = (c.req.header('x-user') ?? '').split(':')
      c.set('user', name ? { id: name, name, username: name, role } : null)
      await next()
    })
    app.route('/api', scopeRoutes({ db, schema, audit: async (r) => void audited.push(`${r.fun} ${r.target}`) }))
    const call = (user: string, method: string, path: string, body?: unknown) =>
      app.request(`/api${path}`, { method, headers: { 'x-user': user, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })

    expect((await call('olga:operator', 'PUT', '/scopes/u-olga', { target: '*', targetType: 'glob' })).status).toBe(403)
    expect((await call('ada:admin', 'PUT', '/scopes/u-olga', { target: 'G@roles:db', targetType: 'regex' })).status).toBe(400)
    expect((await call('ada:admin', 'PUT', '/scopes/nobody', { target: '*', targetType: 'glob' })).status).toBe(404)
    expect((await call('ada:admin', 'PUT', '/scopes/u-olga', { target: 'G@roles:db', targetType: 'compound' })).status).toBe(200)
    expect(await loadScope(db, schema, 'u-olga')).toEqual({ target: 'G@roles:db', targetType: 'compound' })
    expect((await (await call('ada:admin', 'GET', '/scopes')).json()) as unknown).toMatchObject({ scopes: [{ userId: 'u-olga', target: 'G@roles:db', updatedBy: 'ada' }] })
    // a second time replaces it
    expect((await call('ada:admin', 'PUT', '/scopes/u-olga', { target: 'db-*', targetType: 'glob' })).status).toBe(200)
    expect(await loadScope(db, schema, 'u-olga')).toEqual({ target: 'db-*', targetType: 'glob' })
    expect((await call('ada:admin', 'DELETE', '/scopes/u-olga')).status).toBe(200)
    expect(await loadScope(db, schema, 'u-olga')).toBeNull()
    expect(audited).toEqual(['user.set_scope olga', 'user.set_scope olga', 'user.clear_scope olga'])
  })
})
