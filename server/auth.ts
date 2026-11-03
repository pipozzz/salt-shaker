import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { admin, genericOAuth, username } from 'better-auth/plugins'
import { adminAc, userAc } from 'better-auth/plugins/admin/access'
import { eq } from 'drizzle-orm'
import type { Config } from './config'
import type { Db, Schema } from './db'
import { isRole } from './roles'
import { emailFromProfile, roleFromClaims, SsoHandoff, usernameFrom } from './sso'

export const CLIENT_IP_HEADER = 'x-salt-shaker-client-ip'
export const OIDC_PROVIDER_ID = 'oidc'

/** Users sign in by username; Better Auth still wants a unique email, so derive one. */
/** Usernames: 3–32 characters, letters, digits, . _ - (the setup page, the Users page and SSO all follow it). */
export const USERNAME = /^[a-z0-9][a-z0-9._-]{2,31}$/i

export const emailFor = (name: string) => `${name.toLowerCase()}@users.salt-shaker.invalid`

export function createAuth(config: Config, db: Db, schema: Schema, provider: 'sqlite' | 'pg') {
  const handoff = new SsoHandoff()
  const oidc = config.oidc

  /** A free username based on the IdP's, for SSO users created on first sign-in. */
  async function freeUsername(base: string) {
    for (let i = 0; i < 50; i++) {
      const candidate = i === 0 ? base : `${base.slice(0, 28)}-${i + 1}`
      const taken = await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.username, candidate))
      if (!taken.length) return candidate
    }
    return `${base.slice(0, 20)}-${Date.now().toString(36)}`
  }

  return betterAuth({
    baseURL: config.publicUrl,
    basePath: '/api/auth',
    trustedOrigins: config.trustedOrigins,
    secret: config.authSecret,
    database: drizzleAdapter(db, { provider, schema }),
    // accounts are created by admins, the first-run setup, or SSO, never by self sign-up
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 10 },
    session: { expiresIn: 60 * 60 * 12, updateAge: 60 * 60 },
    rateLimit: { enabled: true, window: 60, max: 30 },
    // set by server/index.ts from the socket (or X-Forwarded-For when TRUST_PROXY is on), never by the client
    advanced: { ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] } },
    plugins: [
      // Better Auth's own default allows no '-' and only 30 characters
      username({ usernameValidator: (u) => USERNAME.test(u), maxUsernameLength: 32 }),
      admin({
        roles: { admin: adminAc, operator: userAc, viewer: userAc, none: userAc },
        adminRoles: ['admin'],
        defaultRole: 'viewer',
      }),
      ...(oidc
        ? [
            genericOAuth({
              config: [
                {
                  providerId: OIDC_PROVIDER_ID,
                  discoveryUrl: oidc.discoveryUrl,
                  clientId: oidc.clientId,
                  clientSecret: oidc.clientSecret,
                  scopes: oidc.scopes,
                  pkce: true,
                  // name/email follow the IdP; the role is applied in the session hook below
                  overrideUserInfo: true,
                  mapProfileToUser: (profile) => {
                    const email = emailFromProfile(profile)
                    handoff.put(email, roleFromClaims(profile, oidc), usernameFrom(profile))
                    return { email, name: typeof profile.name === 'string' && profile.name ? profile.name : usernameFrom(profile), emailVerified: true }
                  },
                },
              ],
            }),
          ]
        : []),
    ],
    databaseHooks: {
      session: {
        create: {
          // the single gate every sign-in passes: apply SSO roles, refuse users without access
          before: async (session) => {
            const [user] = await db.select().from(schema.user).where(eq(schema.user.id, session.userId))
            if (!user) return false
            const sso = handoff.take(user.email)
            const changes: { role?: string; username?: string } = {}
            if (sso) {
              const isNew = Date.now() - new Date(user.createdAt).getTime() < 60_000
              // roles come from the IdP when a role claim is configured; otherwise only new users get the default
              const role = sso.role ?? (isNew ? oidc!.defaultRole : null)
              if (role && role !== user.role) changes.role = role
              if (!user.username) changes.username = await freeUsername(sso.username)
              if (Object.keys(changes).length) await db.update(schema.user).set(changes).where(eq(schema.user.id, user.id))
            }
            const role = changes.role ?? user.role
            if (!isRole(role) || role === 'none') return false
            // with PASSWORD_LOGIN=admins, only admins may get a session without going through SSO
            if (!sso && oidc && config.passwordLogin === 'admins' && role !== 'admin') return false
            return { data: session }
          },
        },
      },
    },
  })
}

export type Auth = ReturnType<typeof createAuth>
