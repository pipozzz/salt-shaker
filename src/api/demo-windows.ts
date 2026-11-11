import { readWindow, windowState, type MaintenanceWindow } from '../lib/windows'
import { recordDemoAudit } from './demo-audit'
import type { maintenance } from './server'

/*
 * The demo's maintenance windows: patch nights on Tuesday and Thursday in the browser's
 * timezone, which the weekly patch scan waits for.
 */

const delay = <T>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 150))
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
let nextId = 2
export const demoWindowList: MaintenanceWindow[] = [{ id: 1, name: 'Patch nights', days: [2, 4], start: '22:00', minutes: 240, timezone: tz }]

export const demoMaintenance: typeof maintenance = {
  list: () => {
    const s = windowState(demoWindowList, Date.now())
    return delay({
      windows: [...demoWindowList].sort((a, b) => a.name.localeCompare(b.name)),
      open: s.open && { id: s.open.window.id, end: s.open.end.toISOString() },
      next: s.next && { id: s.next.window.id, start: s.next.start.toISOString(), end: s.next.end.toISOString() },
    })
  },
  add: (input) => {
    const w = readWindow(input as unknown as Record<string, unknown>)
    if ('error' in w) return Promise.reject(new Error(w.error))
    if (demoWindowList.some((x) => x.name === w.name)) return Promise.reject(new Error('A window with this name already exists'))
    const window = { id: nextId++, ...w }
    demoWindowList.push(window)
    recordDemoAudit({ username: 'demo', client: 'admin', fun: 'window.add', target: w.name, args: JSON.stringify(w), outcome: 'ok' })
    return delay({ window })
  },
  remove: (id) => {
    const i = demoWindowList.findIndex((w) => w.id === id)
    if (i >= 0) {
      recordDemoAudit({ username: 'demo', client: 'admin', fun: 'window.remove', target: demoWindowList[i].name, outcome: 'ok' })
      demoWindowList.splice(i, 1)
    }
    return delay({})
  },
}
