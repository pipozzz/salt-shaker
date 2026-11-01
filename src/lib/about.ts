/**
 * AGPL-3.0 §13: users interacting with the app over a network must be offered its source.
 * Forks that change the code should point VITE_SOURCE_URL at their own repository.
 */
export const SOURCE_URL = (import.meta.env.VITE_SOURCE_URL as string | undefined) ?? 'https://github.com/pipozzz/salt-shaker'
export const LICENSE_NAME = 'AGPL-3.0'
export const VERSION = __APP_VERSION__
