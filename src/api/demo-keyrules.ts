import { recordDemoAudit } from './demo-audit'
import { demoAcceptKey, demoPendingKeys } from './mock'
import type { KeyRule, keyRules } from './server'

/*
 * The demo's enrollment windows: open one and the waiting keys that match are accepted at once,
 * as the server does when they knock. Kept in the browser.
 */

const delay = <T>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 100))
let nextId = 1
const list: KeyRule[] = []
const glob = (pattern: string, id: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`).test(id)

export const demoKeyRules: typeof keyRules = {
  list: () => delay({ rules: list.map((r) => ({ ...r, accepted: [...r.accepted] })) }),
  open: (pattern: string, hours: number, maxAccepts: number) => {
    if (pattern.replace(/[*?]/g, '').length < 3) return Promise.reject(new Error('The pattern has to name the minions, e.g. web-2026-* (at least 3 characters besides * and ?)'))
    const now = Date.now()
    const rule: KeyRule = { id: nextId++, pattern, expiresAt: new Date(now + hours * 3600_000).toISOString(), maxAccepts, accepted: [], createdBy: 'demo', createdAt: new Date(now).toISOString() }
    list.unshift(rule)
    recordDemoAudit({ username: 'demo', client: 'console', fun: 'keys.open_window', target: pattern, args: JSON.stringify({ hours, maxAccepts }), outcome: 'ok' })
    for (const id of demoPendingKeys()) {
      if (rule.accepted.length >= maxAccepts || !glob(pattern, id)) continue
      if (demoAcceptKey(id)) {
        rule.accepted.push(id)
        recordDemoAudit({ username: `rule:${pattern}`, role: 'system', client: 'wheel', fun: 'key.accept', target: id, outcome: 'ok' })
      }
    }
    return delay({ rule })
  },
  close: (id: number) => {
    const r = list.find((x) => x.id === id)
    if (r) {
      r.expiresAt = new Date().toISOString()
      recordDemoAudit({ username: 'demo', client: 'console', fun: 'keys.close_window', target: r.pattern, outcome: 'ok' })
    }
    return delay({})
  },
}
