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

  // the rule the setup page, the Users page and SSO all use: 3–32 characters, letters, digits, . _ -
  it.each(['john-doe', 'a.b_c', 'x'.repeat(32)])('accepts %s and lets it sign in', async (username) => {
    const opened = await openTestDatabase(dialect)
    close = opened.close
    const auth = createAuth(config, opened.db, opened.schema, dialect === 'pg' ? 'pg' : 'sqlite')
    const password = 'correct-horse-battery'
    await auth.api.createUser({ body: { email: emailFor(username), password, name: username, role: 'viewer', data: { username } } })
    const res = await auth.api.signInUsername({ body: { username, password } })
    expect(res?.user).toMatchObject({ username })
  })
})
