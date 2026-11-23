import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { securityRoutes } from './routes/security'
import { openTestDatabase, testDialects } from './testdb'
import type { Env } from './types'

describe.each(testDialects)('sign-in security for admins (%s)', (dialect) => {
  let close: (() => Promise<unknown>) | null = null
  afterEach(async () => {
    await close?.()
    close = null
  })

  it('shows who has a second step or passkeys, and takes them away', async () => {
    const opened = await openTestDatabase(dialect)
    close = opened.close
    const { db, schema } = opened
    const now = new Date()
    for (const [id, twoFactorEnabled] of [['u-pam', false], ['u-olga', true], ['u-vic', false]] as const)
      await db.insert(schema.user).values({ id, name: id.slice(2), email: `${id}@x.invalid`, username: id.slice(2), role: id === 'u-pam' ? 'admin' : 'operator', twoFactorEnabled, createdAt: now, updatedAt: now })
    await db.insert(schema.twoFactor).values({ id: 'tf1', userId: 'u-olga', secret: 'enc', backupCodes: 'enc' })
    const key = { publicKey: 'pk', counter: 0, deviceType: 'singleDevice', backedUp: false }
    await db.insert(schema.passkey).values([
      { id: 'p1', userId: 'u-olga', credentialID: 'c1', ...key },
      { id: 'p2', userId: 'u-olga', credentialID: 'c2', ...key },
      { id: 'p3', userId: 'u-vic', credentialID: 'c3', ...key },
    ])
    await db.insert(schema.session).values({ id: 's1', userId: 'u-olga', token: 't1', expiresAt: new Date(+now + 3600_000), createdAt: now, updatedAt: now })

    const audited: string[] = []
    const app = new Hono<Env>()
    app.use('*', async (c, next) => {
      const as = c.req.header('x-as') ?? 'pam'
      c.set('user', as === 'nobody' ? null : { id: `u-${as}`, name: as, username: as, role: as === 'pam' ? 'admin' : 'operator' })
      await next()
    })
    app.route('/api', securityRoutes({ db, schema, audit: async (r) => void audited.push(`${r.username} ${r.fun} ${r.target} ${r.args}`) }))
    const call = async (method: string, path: string, as?: string) => {
      const res = await app.request(`/api${path}`, { method, headers: as ? { 'x-as': as } : {} })
      return { status: res.status, body: (await res.json()) as Record<string, unknown> }
    }

    expect((await call('GET', '/users/security', 'olga')).status).toBe(403)
    expect((await call('POST', '/users/u-vic/reset-sign-in', 'olga')).status).toBe(403)
    expect((await call('GET', '/users/security', 'nobody')).status).toBe(401)
    expect((await call('GET', '/users/security')).body).toEqual({ users: { 'u-olga': { twoFactor: true, passkeys: 2 }, 'u-vic': { twoFactor: false, passkeys: 1 } } })

    expect((await call('POST', '/users/u-nobody/reset-sign-in')).status).toBe(404)
    expect((await call('POST', '/users/u-olga/reset-sign-in')).body).toEqual({ ok: true, twoFactor: true, passkeys: 2 })
    expect((await call('GET', '/users/security')).body).toEqual({ users: { 'u-vic': { twoFactor: false, passkeys: 1 } } })
    const [olga] = await db.select().from(schema.user).where(eq(schema.user.id, 'u-olga'))
    expect(olga.twoFactorEnabled).toBe(false)
    // signed out everywhere: whoever has the lost device may have a session too
    expect(await db.select().from(schema.session)).toEqual([])
    expect(audited).toEqual(['pam user.reset_sign_in olga {"twoFactor":true,"passkeys":2}'])
  })
})
