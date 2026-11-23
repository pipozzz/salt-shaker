import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { inviteRoutes } from './invites'
import { openTestDatabase, testDialects } from './testdb'
import type { Env } from './types'

describe.each(testDialects)('invitations (%s)', (dialect) => {
  let close: (() => Promise<unknown>) | null = null
  afterEach(async () => {
    await close?.()
    close = null
  })

  async function setup(opts: { passwordAllowed?: (role: string) => boolean } = {}) {
    const opened = await openTestDatabase(dialect)
    close = opened.close
    const { db, schema } = opened
    const clock = { now: new Date('2026-11-20T10:00:00Z') }
    const audited: string[] = []
    const created: Array<{ username: string; name: string; password: string; role: string }> = []
    let fail = false
    const app = new Hono<Env>()
    app.use('*', async (c, next) => {
      const as = c.req.header('x-as')
      c.set('user', as === 'nobody' ? null : { id: `u-${as ?? 'pam'}`, name: as ?? 'pam', username: as ?? 'pam', role: as === 'olga' ? 'operator' : 'admin' })
      c.set('via', (c.req.header('x-via') as 'token' | undefined) ?? 'session')
      await next()
    })
    app.route(
      '/api',
      inviteRoutes({
        db,
        schema,
        audit: async (r) => void audited.push(`${r.username} ${r.fun} ${r.target} ${r.outcome}`),
        createUser: async (u) => {
          if (fail) throw new Error('database is busy')
          created.push(u)
          const at = new Date()
          await db.insert(schema.user).values({ id: `u-${u.username}`, name: u.name, email: `${u.username}@x.invalid`, username: u.username, role: u.role, createdAt: at, updatedAt: at })
          return `u-${u.username}`
        },
        now: () => clock.now,
        ...opts,
      }),
    )
    const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await app.request(`/api${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined })
      return { status: res.status, body: (await res.json()) as Record<string, unknown> }
    }
    return { db, schema, call, audited, created, clock, failing: (v: boolean) => (fail = v) }
  }

  it('are made by admins and turned into an account by whoever has the link, once', async () => {
    const { db, schema, call, audited, created } = await setup()
    // admins only, from the web UI
    expect((await call('POST', '/invites', { username: 'nina', role: 'viewer' }, { 'x-as': 'olga' })).status).toBe(403)
    expect((await call('GET', '/invites', undefined, { 'x-as': 'nobody' })).status).toBe(401)
    expect((await call('POST', '/invites', { username: 'nina', role: 'viewer' }, { 'x-via': 'token' })).status).toBe(403)
    // what's refused
    expect((await call('POST', '/invites', { username: 'x', role: 'viewer' })).status).toBe(400)
    // an email address is a username too
    expect((await call('POST', '/invites', { username: 'Eva@Example.com', role: 'viewer' })).body).toMatchObject({ username: 'eva@example.com' })
    expect((await call('POST', '/invites', { username: 'nina', role: 'none' })).status).toBe(400)
    expect((await call('POST', '/invites', { username: 'nina', role: 'viewer', days: 90 })).status).toBe(400)
    expect((await call('POST', '/invites', { username: 'nina', role: 'viewer', scope: { target: 'web-*', targetType: 'glob' } })).status).toBe(400)

    const made = await call('POST', '/invites', { username: 'Nina', name: 'Nina Novak', role: 'operator', scope: { target: 'web-*', targetType: 'glob' } })
    expect(made.status).toBe(201)
    const token = made.body.token as string
    expect(token).toMatch(/^inv_[\w-]{43}$/)
    expect(made.body).toMatchObject({ username: 'nina', role: 'operator', createdBy: 'pam', expired: false, expiresAt: '2026-11-27T10:00:00.000Z' })
    expect((await call('POST', '/invites', { username: 'nina', role: 'viewer' })).status).toBe(409)
    // listed without the link or its hash
    const list = await call('GET', '/invites')
    expect(list.body.invites).toMatchObject([{ username: 'eva@example.com' }, { username: 'nina', scopeTarget: 'web-*' }])
    expect(JSON.stringify(list.body)).not.toContain(token)
    expect(JSON.stringify(list.body)).not.toContain('tokenHash')

    // the link, opened without being signed in
    const anon = { 'x-as': 'nobody' }
    expect((await call('GET', `/invite/${token}`, undefined, anon)).body).toEqual({ username: 'nina', name: 'Nina Novak', role: 'operator', expiresAt: '2026-11-27T10:00:00.000Z' })
    expect((await call('GET', '/invite/inv_nope', undefined, anon)).status).toBe(404)
    expect((await call('POST', `/invite/${token}`, { password: 'short' }, anon)).status).toBe(400)
    const accepted = await call('POST', `/invite/${token}`, { password: 'correct horse battery' }, anon)
    expect(accepted).toEqual({ status: 201, body: { ok: true, username: 'nina' } })
    expect(created).toEqual([{ username: 'nina', name: 'Nina Novak', password: 'correct horse battery', role: 'operator' }])
    // the limit the admin chose is there from the first sign-in
    expect(await db.select().from(schema.userScope)).toMatchObject([{ userId: 'u-nina', target: 'web-*', targetType: 'glob', updatedBy: 'pam' }])
    // once
    expect((await call('POST', `/invite/${token}`, { password: 'correct horse battery' }, anon)).status).toBe(404)
    expect((await call('GET', `/invite/${token}`, undefined, anon)).status).toBe(404)
    expect((await call('GET', '/invites')).body.invites).toMatchObject([{ username: 'eva@example.com' }])
    // and an existing user can't be invited
    expect((await call('POST', '/invites', { username: 'nina', role: 'viewer' })).status).toBe(409)
    expect(audited).toEqual(['pam user.invite eva@example.com ok', 'pam user.invite nina ok', 'nina user.accept_invite nina ok'])
  })

  it('expire, and can be replaced by a new link or revoked', async () => {
    const { call, clock, audited } = await setup()
    const first = (await call('POST', '/invites', { username: 'ivan', role: 'viewer', days: 1 })).body
    clock.now = new Date('2026-11-21T10:00:01Z')
    expect((await call('GET', `/invite/${first.token}`)).status).toBe(404)
    expect((await call('POST', `/invite/${first.token}`, { password: 'correct horse battery' })).status).toBe(404)
    expect((await call('GET', '/invites')).body.invites).toMatchObject([{ username: 'ivan', expired: true }])

    const renewed = (await call('POST', `/invites/${first.id}/renew`, { days: 7 })).body
    expect(renewed).toMatchObject({ username: 'ivan', expired: false, expiresAt: '2026-11-28T10:00:01.000Z' })
    expect(renewed.token).not.toBe(first.token)
    // the old link is dead, the new one works
    expect((await call('GET', `/invite/${first.token}`)).status).toBe(404)
    expect((await call('GET', `/invite/${renewed.token}`)).status).toBe(200)

    expect((await call('DELETE', `/invites/${first.id}`)).status).toBe(200)
    expect((await call('DELETE', `/invites/${first.id}`)).status).toBe(404)
    expect((await call('POST', `/invites/${first.id}/renew`, {})).status).toBe(404)
    expect((await call('GET', `/invite/${renewed.token}`)).status).toBe(404)
    expect(audited).toEqual(['pam user.invite ivan ok', 'pam user.renew_invite ivan ok', 'pam user.revoke_invite ivan ok'])
  })

  it('stay usable when the account could not be created', async () => {
    const { call, failing, created } = await setup()
    const { token } = (await call('POST', '/invites', { username: 'dana', role: 'viewer' })).body
    failing(true)
    expect((await call('POST', `/invite/${token}`, { password: 'correct horse battery' })).status).toBe(500)
    failing(false)
    expect((await call('POST', `/invite/${token}`, { password: 'correct horse battery', name: 'Dana' })).status).toBe(201)
    expect(created).toMatchObject([{ username: 'dana', name: 'Dana', role: 'viewer' }])
  })

  it("aren't made for roles that can't sign in with a password", async () => {
    const { call } = await setup({ passwordAllowed: (role) => role === 'admin' })
    expect((await call('POST', '/invites', { username: 'vera', role: 'viewer' })).status).toBe(400)
    expect((await call('POST', '/invites', { username: 'adam', role: 'admin' })).status).toBe(201)
  })
})
