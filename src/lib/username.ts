/** Local usernames: a short name (3–32 characters: letters, digits, . _ -) or an email address. */
const NAME = /^[a-z0-9][a-z0-9._-]{2,31}$/i
const EMAIL = /^[a-z0-9._%+'-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i
export const MAX_USERNAME = 254

export const USERNAME_RULE = '3–32 characters (letters, digits, . _ -), or an email address'

export const isUsername = (u: string) => NAME.test(u) || (u.length <= MAX_USERNAME && EMAIL.test(u))

/** Where accounts without an email of their own get one; Better Auth wants a unique email per user. */
export const LOCAL_EMAIL_DOMAIN = 'users.salt-shaker.invalid'

/** The account's email: the username itself when it's an address, else one derived from it. */
export const emailFor = (username: string) => (username.includes('@') ? username.toLowerCase() : `${username.toLowerCase()}@${LOCAL_EMAIL_DOMAIN}`)

/** Whether a user signs in with a password here, rather than through SSO (whose usernames never hold an @). */
export const isLocalAccount = (u: { email: string; username?: string | null }) =>
  u.email.endsWith(`@${LOCAL_EMAIL_DOMAIN}`) || (!!u.username && u.email === u.username.toLowerCase())
