import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { queryRoutes } from './routes/queries'
import { openTestDatabase, testDialects } from './testdb'
import type { Env } from './types'

describe.each(testDialects)('saved osquery queries (%s)', (dialect) => {
  let close: (() => Promise<unknown>) | null = null
  afterEach(async () => {
    await close?.()
    close = null
  })

  async function setup() {
    const opened = await openTestDatabase(dialect)
    close = opened.close
    const app = new Hono<Env>()
    app.use('*', async (c, next) => {
      const [name, role] = (c.req.header('x-user') ?? '').split(':')
      c.set('user', name ? { id: name, name, username: name, role } : null)
      await next()
    })
    app.route('/api', queryRoutes(opened))
    return (user: string, method: string, path: string, body?: unknown) =>
      app.request(`/api${path}`, { method, headers: { 'x-user': user, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  }

  it('lets operators save queries everyone reads, and replace their own', async () => {
    const call = await setup()
    expect((await call('olga:operator', 'POST', '/queries', { name: 'Root shells', sql: 'SELECT * FROM users WHERE uid = 0' })).status).toBe(201)
    expect((await call('olga:operator', 'POST', '/queries', { name: 'Root shells', sql: "SELECT username, shell FROM users WHERE uid = 0;" })).status).toBe(200)
    const { queries } = (await (await call('vic:viewer', 'GET', '/queries')).json()) as { queries: unknown[] }
    expect(queries).toMatchObject([{ name: 'Root shells', sql: 'SELECT username, shell FROM users WHERE uid = 0;', createdBy: 'olga' }])
  })

  it('keeps out viewers, other operators, and anything but one SELECT', async () => {
    const call = await setup()
    expect((await call('vic:viewer', 'POST', '/queries', { name: 'x', sql: 'SELECT 1' })).status).toBe(403)
    expect((await call('olga:operator', 'POST', '/queries', { name: 'x', sql: 'DROP TABLE users' })).status).toBe(400)
    expect((await call('olga:operator', 'POST', '/queries', { name: 'x', sql: 'SELECT 1; SELECT 2' })).status).toBe(400)
    expect((await call('olga:operator', 'POST', '/queries', { name: '', sql: 'SELECT 1' })).status).toBe(400)
    const created = (await (await call('olga:operator', 'POST', '/queries', { name: 'Ports', sql: 'SELECT * FROM listening_ports' })).json()) as { query: { id: number } }
    expect((await call('otto:operator', 'POST', '/queries', { name: 'Ports', sql: 'SELECT 1' })).status).toBe(409)
    expect((await call('otto:operator', 'DELETE', `/queries/${created.query.id}`)).status).toBe(403)
    expect((await call('ada:admin', 'DELETE', `/queries/${created.query.id}`)).status).toBe(200)
    expect((await call('nina:none', 'GET', '/queries')).status).toBe(403)
    expect((await call('', 'GET', '/queries')).status).toBe(401)
  })
})
