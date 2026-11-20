import { describe, expect, it } from 'vitest'
import { emailFor, isLocalAccount, isUsername } from './username'

describe('usernames', () => {
  it('takes short names and email addresses', () => {
    for (const u of ['pam', 'olga.ops', 'ci_bot-2', 'peter@firefish.io', 'p.gonda+salt@mail.example.co.uk']) expect(isUsername(u), u).toBe(true)
  })
  it('refuses the rest', () => {
    for (const u of ['ab', '-pam', 'pam smith', 'a'.repeat(33), 'peter@', '@firefish.io', 'peter@localhost', 'a@b@c.io', 'peter@-x.io', `${'a'.repeat(250)}@x.io`])
      expect(isUsername(u), u).toBe(false)
  })
  it('uses an address as the email and derives one for short names', () => {
    expect(emailFor('Peter@Firefish.io')).toBe('peter@firefish.io')
    expect(emailFor('Pam')).toBe('pam@users.salt-shaker.invalid')
  })
  it('tells local accounts from SSO ones', () => {
    expect(isLocalAccount({ email: 'pam@users.salt-shaker.invalid', username: 'pam' })).toBe(true)
    expect(isLocalAccount({ email: 'peter@firefish.io', username: 'peter@firefish.io' })).toBe(true)
    // SSO users get a cleaned-up username and the IdP's email
    expect(isLocalAccount({ email: 'otto@example.com', username: 'otto' })).toBe(false)
  })
})
