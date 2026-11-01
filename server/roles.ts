import { makeCan } from '../src/lib/perms'

export const ROLES = ['admin', 'operator', 'viewer'] as const
export type Role = (typeof ROLES)[number]

/**
 * Each role expressed in Salt's eauth perms format, so the UI's permission logic
 * (src/lib/perms.ts) and the server's enforcement read the same rules.
 */
export const ROLE_PERMS: Record<Role, unknown[]> = {
  admin: ['.*', '@wheel', '@runner', '@jobs'],
  // runs anything on minions, but cannot manage keys or see raw pillar files
  operator: [
    '.*',
    '@jobs',
    { '@runner': ['manage.status', 'manage.versions', 'cache.grains', 'jobs.*', 'pillar.show_pillar', 'salt.cmd', 'state.orchestrate'] },
    { '@wheel': ['key.list_all', 'key.finger', 'file_roots.list_roots', 'file_roots.read', 'file_roots.list_env'] },
  ],
  // read-only; no pillar access, which commonly holds secrets
  viewer: [
    'test.ping',
    'grains.*',
    'pkg.list_upgrades',
    'pkg.version',
    'sys.list_functions',
    'saltutil.find_job',
    { '@runner': ['manage.status', 'cache.grains', 'jobs.*', 'salt.cmd'] },
    { '@wheel': ['key.list_all', 'key.finger', 'file_roots.list_roots', 'file_roots.read', 'file_roots.list_env'] },
  ],
}

export const isRole = (r: unknown): r is Role => typeof r === 'string' && (ROLES as readonly string[]).includes(r)

export function canFor(role: string | null | undefined) {
  return makeCan(ROLE_PERMS[isRole(role) ? role : 'viewer'])
}
