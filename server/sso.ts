import type { OidcConfig } from './config'
import type { Role } from './roles'

/** The role an IdP profile maps to, highest match wins; null when roles aren't managed by the IdP. */
export function roleFromClaims(profile: Record<string, unknown>, cfg: OidcConfig): Role | null {
  if (!cfg.roleClaim) return null
  // dotted paths reach nested claims, e.g. realm_access.roles in Keycloak
  const raw = cfg.roleClaim.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), profile)
  const values = new Set((Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,]+/) : []).map(String))
  for (const role of ['admin', 'operator', 'viewer'] as const) {
    if (cfg.groups[role].some((g) => values.has(g))) return role
  }
  return cfg.defaultRole
}

/** A username for a new SSO user: preferred_username, else the email's local part, cleaned up. */
export function usernameFrom(profile: Record<string, unknown>) {
  const raw = [profile.preferred_username, typeof profile.email === 'string' ? profile.email.split('@')[0] : null, profile.sub].find((v) => typeof v === 'string' && v.trim())
  const clean = String(raw ?? 'user')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 32)
  return clean.length >= 3 ? clean : `${clean}-sso`.replace(/^-/, 'user-')
}

/** IdPs without an email claim still need a unique email for Better Auth. */
export const emailFromProfile = (profile: Record<string, unknown>) =>
  typeof profile.email === 'string' && profile.email.includes('@') ? profile.email.toLowerCase() : `${String(profile.sub ?? profile.id)}@sso.salt-shaker.invalid`

/**
 * Carries what the IdP said about a user from the OAuth callback (mapProfileToUser) to the
 * moment the session is created, keyed by email. Entries expire quickly.
 */
export class SsoHandoff {
  private pending = new Map<string, { role: Role | null; username: string; at: number }>()

  put(email: string, role: Role | null, username: string) {
    this.pending.set(email, { role, username, at: Date.now() })
    for (const [k, v] of this.pending) if (Date.now() - v.at > 120_000) this.pending.delete(k)
  }

  take(email: string) {
    const v = this.pending.get(email)
    this.pending.delete(email)
    return v && Date.now() - v.at < 120_000 ? v : null
  }
}
