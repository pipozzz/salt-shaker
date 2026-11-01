import { describe, expect, it } from 'vitest'
import type { OidcConfig } from './config'
import { emailFromProfile, roleFromClaims, SsoHandoff, usernameFrom } from './sso'

const cfg: OidcConfig = {
  name: 'SSO',
  discoveryUrl: 'https://idp/.well-known/openid-configuration',
  clientId: 'c',
  clientSecret: 's',
  scopes: ['openid'],
  roleClaim: 'groups',
  groups: { admin: ['salt-admins'], operator: ['salt-operators', 'ops'], viewer: ['salt-viewers'] },
  defaultRole: 'none',
}

describe('roleFromClaims', () => {
  it('maps groups to the highest matching role', () => {
    expect(roleFromClaims({ groups: ['salt-viewers', 'salt-admins'] }, cfg)).toBe('admin')
    expect(roleFromClaims({ groups: ['ops'] }, cfg)).toBe('operator')
    expect(roleFromClaims({ groups: ['salt-viewers'] }, cfg)).toBe('viewer')
  })

  it('falls back to the default role when nothing matches', () => {
    expect(roleFromClaims({ groups: ['marketing'] }, cfg)).toBe('none')
    expect(roleFromClaims({}, cfg)).toBe('none')
    expect(roleFromClaims({}, { ...cfg, defaultRole: 'viewer' })).toBe('viewer')
  })

  it('reads nested claims and space-separated strings', () => {
    expect(roleFromClaims({ realm_access: { roles: ['salt-operators'] } }, { ...cfg, roleClaim: 'realm_access.roles' })).toBe('operator')
    expect(roleFromClaims({ roles: 'foo salt-admins' }, { ...cfg, roleClaim: 'roles' })).toBe('admin')
  })

  it('leaves roles alone when no role claim is configured', () => {
    expect(roleFromClaims({ groups: ['salt-admins'] }, { ...cfg, roleClaim: null })).toBeNull()
  })
})

describe('profile helpers', () => {
  it('derives a clean username', () => {
    expect(usernameFrom({ preferred_username: 'Alice.Smith' })).toBe('alice.smith')
    expect(usernameFrom({ email: 'Bob+ops@example.com' })).toBe('bob-ops')
    expect(usernameFrom({ sub: '_x' })).toBe('x-sso')
  })

  it('synthesizes an email when the IdP has none', () => {
    expect(emailFromProfile({ email: 'A@Example.com', sub: '1' })).toBe('a@example.com')
    expect(emailFromProfile({ sub: 'abc' })).toBe('abc@sso.salt-shaker.invalid')
  })

  it('hands IdP data to the session hook once', () => {
    const h = new SsoHandoff()
    h.put('a@x', 'operator', 'a')
    expect(h.take('a@x')).toMatchObject({ role: 'operator', username: 'a' })
    expect(h.take('a@x')).toBeNull()
  })
})
