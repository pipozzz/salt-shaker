import { recordDemoAudit } from './demo-audit'
import type { ApiToken, tokens } from './server'

/* The demo's API tokens: made-up, kept in the browser, and nothing accepts them. */

const delay = <T>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 100))
let nextId = 2
const list: ApiToken[] = [{ id: 1, name: 'gitlab: deploy pipeline', prefix: 'ss_Qm9vdG', createdAt: new Date(Date.now() - 40 * 86400_000).toISOString(), expiresAt: new Date(Date.now() + 50 * 86400_000).toISOString(), lastUsedAt: new Date(Date.now() - 3600_000).toISOString() }]

const randomToken = () => `ss_${Array.from(crypto.getRandomValues(new Uint8Array(43)), (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[b % 64]).join('')}`

export const demoTokens: typeof tokens = {
  list: () => delay({ tokens: [...list] }),
  create: (name: string, days: number | null) => {
    if (!name.trim()) return Promise.reject(new Error('Name it, e.g. after the job that uses it'))
    const token = randomToken()
    const t: ApiToken = { id: nextId++, name: name.trim(), prefix: token.slice(0, 10), createdAt: new Date().toISOString(), expiresAt: days ? new Date(Date.now() + days * 86400_000).toISOString() : null, lastUsedAt: null }
    list.unshift(t)
    recordDemoAudit({ username: 'demo', client: 'console', fun: 'token.create', target: t.name, outcome: 'ok' })
    return delay({ ...t, token })
  },
  remove: (id: number) => {
    const i = list.findIndex((t) => t.id === id)
    if (i >= 0) recordDemoAudit({ username: 'demo', client: 'console', fun: 'token.delete', target: list[i].name, outcome: 'ok' })
    if (i >= 0) list.splice(i, 1)
    return delay({})
  },
}
