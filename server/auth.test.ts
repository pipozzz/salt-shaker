import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { createAuth, emailFor } from './auth'
import type { Config } from './config'
import { openTestDatabase, testDialects } from './testdb'

const config = { publicUrl: 'http://localhost:8080', authSecret: 'test-secret-0123456789abcdef0123456789', trustedOrigins: [], passwordLogin: 'all', oidc: null } as unknown as Config

describe.each(testDialects)('usernames (%s)', (dialect) => {
  let close: (() => Promise<unknown>) | null = null
  afterEach(async () => {
    await close?.()
    close = null
  })

  // the rule the setup page and the Users page use: 3–32 characters (letters, digits, . _ -), or an email address
  it.each(['john-doe', 'a.b_c', 'x'.repeat(32), 'peter@firefish.io', 'ops+salt@mail.example.co.uk'])('accepts %s and lets it sign in', async (username) => {
    const opened = await openTestDatabase(dialect)
    close = opened.close
    const auth = createAuth(config, opened.db, opened.schema, dialect === 'pg' ? 'pg' : 'sqlite')
    const password = 'correct-horse-battery'
    await auth.api.createUser({ body: { email: emailFor(username), password, name: username, role: 'viewer', data: { username } } })
    const res = await auth.api.signInUsername({ body: { username, password } })
    expect(res?.user).toMatchObject({ username })
    // an address is the account's real email; a short name gets a made-up one
    expect(res?.user.email).toBe(username.includes('@') ? username : `${username}@users.salt-shaker.invalid`)
  })

  it('refuses names outside the rule', async () => {
    const opened = await openTestDatabase(dialect)
    close = opened.close
    const auth = createAuth(config, opened.db, opened.schema, dialect === 'pg' ? 'pg' : 'sqlite')
    for (const username of ['pam smith', 'peter@', 'x'.repeat(33)])
      await expect(auth.api.createUser({ body: { email: emailFor(username.replace(/[@ ]/g, '')), password: 'correct-horse-battery', name: 'x', role: 'viewer', data: { username } } }), username).rejects.toThrow()
  })
})

describe.each(testDialects)('last sign-in (%s)', (dialect) => {
  it('is empty until the user signs in, then shows in the admin user list', async () => {
    const { db, schema, close } = await openTestDatabase(dialect)
    try {
      const auth = createAuth(config, db, schema, dialect === 'pg' ? 'pg' : 'sqlite')
      const password = 'correct-horse-battery'
      const { user } = await auth.api.createUser({ body: { email: emailFor('otto'), password, name: 'otto', role: 'viewer', data: { username: 'otto' } } })
      expect(user).toMatchObject({ lastSignInAt: null })
      const before = Date.now()
      const signIn = await auth.api.signInUsername({ body: { username: 'otto', password }, asResponse: true })
      const at = async () => (await db.select({ at: schema.user.lastSignInAt }).from(schema.user).where(eq(schema.user.id, user.id)))[0]?.at
      expect((await at())?.getTime()).toBeGreaterThanOrEqual(before)
      // users can't backdate it themselves
      const cookie = signIn.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
      const res = await auth.handler(
        new Request('http://localhost:8080/api/auth/update-user', { method: 'POST', headers: { cookie, origin: 'http://localhost:8080', 'content-type': 'application/json' }, body: JSON.stringify({ lastSignInAt: '2000-01-01T00:00:00Z' }) }),
      )
      expect(res.status).not.toBe(200)
      expect((await at())?.getTime()).toBeGreaterThanOrEqual(before)
    } finally {
      await close()
    }
  })
})
