import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { admin, username } from 'better-auth/plugins'
import { adminAc, userAc } from 'better-auth/plugins/admin/access'
import type { Config } from './config'
import type { Db, Schema } from './db'

export function createAuth(config: Config, db: Db, schema: Schema, provider: 'sqlite' | 'pg') {
  return betterAuth({
    baseURL: config.publicUrl,
    basePath: '/api/auth',
    trustedOrigins: config.trustedOrigins,
    secret: config.authSecret,
    database: drizzleAdapter(db, { provider, schema }),
    // accounts are created by admins (or the first-run setup), never by self sign-up
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 10 },
    session: { expiresIn: 60 * 60 * 12, updateAge: 60 * 60 },
    rateLimit: { enabled: true, window: 60, max: 30 },
    plugins: [
      username(),
      admin({
        roles: { admin: adminAc, operator: userAc, viewer: userAc },
        adminRoles: ['admin'],
        defaultRole: 'viewer',
      }),
    ],
  })
}

export type Auth = ReturnType<typeof createAuth>

/** Users sign in by username; Better Auth still wants a unique email, so derive one. */
export const emailFor = (name: string) => `${name.toLowerCase()}@users.salt-shaker.invalid`
