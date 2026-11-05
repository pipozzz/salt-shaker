import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { targetRoutes } from './routes/targets'
import { openTestDatabase, testDialects } from './testdb'
import type { Env } from './types'

describe.each(testDialects)('saved targets (%s)', (dialect) => {
  let close: (() => Promise<unknown>) | null = null
  afterEach(async () => {
    await close?.()
    close = null
  })

  async function setup() {
    const opened = await openTestDatabase(dialect)
    close = opened.close
    const app = new Hono<Env>()
    // the signed-in user comes from a header here: "name:role"
    app.use('*', async (c, next) => {
      const [name, role] = (c.req.header('x-user') ?? '').split(':')
      c.set('user', name ? { id: name, name, username: name, role } : null)
      await next()
    })
    app.route('/api', targetRoutes(opened))
    const call = (user: string, method: string, path: string, body?: unknown) =>
      app.request(`/api${path}`, { method, headers: { 'x-user': user, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    return call
  }

  it('lets operators share targets that everyone reads, and replace their own', async () => {
    const call = await setup()
    expect((await call('olga:operator', 'POST', '/targets', { name: 'web', target: 'web-*', targetType: 'glob' })).status).toBe(201)
    expect((await call('olga:operator', 'POST', '/targets', { name: 'web', target: 'G@roles:web', targetType: 'compound' })).status).toBe(200)
    const res = await call('vic:viewer', 'GET', '/targets')
    const { targets } = (await res.json()) as { targets: Array<{ name: string; target: string; targetType: string; createdBy: string }> }
    expect(targets).toMatchObject([{ name: 'web', target: 'G@roles:web', targetType: 'compound', createdBy: 'olga' }])
  })

  it("keeps viewers from sharing and others from replacing or removing someone's target", async () => {
    const call = await setup()
    expect((await call('vic:viewer', 'POST', '/targets', { name: 'x', target: '*', targetType: 'glob' })).status).toBe(403)
    const created = (await (await call('olga:operator', 'POST', '/targets', { name: 'db', target: 'db-*', targetType: 'glob' })).json()) as { target: { id: number } }
    expect((await call('otto:operator', 'POST', '/targets', { name: 'db', target: '*', targetType: 'glob' })).status).toBe(409)
    expect((await call('otto:operator', 'DELETE', `/targets/${created.target.id}`)).status).toBe(403)
    // an admin may
    expect((await call('ada:admin', 'DELETE', `/targets/${created.target.id}`)).status).toBe(200)
    expect((await (await call('ada:admin', 'GET', '/targets')).json()) as unknown).toEqual({ targets: [] })
  })

  it('validates the target and rejects users without a role', async () => {
    const call = await setup()
    expect((await call('olga:operator', 'POST', '/targets', { name: 'x', target: '*', targetType: 'regex' })).status).toBe(400)
    expect((await call('olga:operator', 'POST', '/targets', { name: '', target: '*', targetType: 'glob' })).status).toBe(400)
    expect((await call('nina:none', 'GET', '/targets')).status).toBe(403)
    expect((await call('', 'GET', '/targets')).status).toBe(401)
  })
})
