import type { Notifier } from './notify'
import type { SaltService } from './salt'
import { minionsDownMessage, minionsUpMessage } from './summaries'

/**
 * Notices minions that stop answering. The events leader runs manage.status every few minutes; a
 * minion missing from `downAfter` checks in a row is reported once, and again when it is back.
 * Minions already down when watching starts are taken as the baseline, not reported.
 */
export class PresenceWatcher {
  private salt: SaltService
  private notifier: Notifier
  private intervalMs: number
  private downAfter: number
  private timer: ReturnType<typeof setInterval> | null = null
  private checking = false
  // null until the first successful check
  private known: Map<string, { misses: number; reported: boolean }> | null = null

  private onSeen?: (up: string[]) => Promise<unknown>

  /** onSeen gets the minions that answered each round (to record when they were last seen). */
  constructor(salt: SaltService, notifier: Notifier, intervalMs: number, downAfter = 2, onSeen?: (up: string[]) => Promise<unknown>) {
    this.salt = salt
    this.onSeen = onSeen
    this.notifier = notifier
    this.intervalMs = intervalMs
    this.downAfter = downAfter
  }

  start() {
    if (this.timer || this.intervalMs <= 0) return
    void this.check()
    this.timer = setInterval(() => void this.check(), this.intervalMs)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    // another instance may have watched meanwhile; start over from a fresh baseline
    this.known = null
  }

  /** One round: ask the master who answers and report changes. Skipped when the master doesn't answer. */
  async check() {
    if (this.checking) return
    this.checking = true
    try {
      let res: { up?: string[]; down?: string[] } | null
      try {
        // kwarg, not a top-level timeout: that one is salt-api's own limit (see SaltApi.status)
        res = (await this.salt.call({ client: 'runner', fun: 'manage.status', kwarg: { timeout: 3, gather_job_timeout: 3 } })) as typeof res
      } catch {
        return
      }
      if (!res || !Array.isArray(res.up) || !Array.isArray(res.down)) return
      await this.observe(res.up, res.down)
      if (this.onSeen && res.up.length) await this.onSeen(res.up).catch((err) => console.warn('presence: recording last seen failed', err))
    } finally {
      this.checking = false
    }
  }

  /** Updates what is known from one manage.status answer and sends what changed. */
  async observe(up: string[], down: string[]) {
    const first = this.known === null
    const known = this.known ?? new Map()
    const wentDown: string[] = []
    const cameBack: string[] = []
    for (const id of up) {
      const k = known.get(id)
      if (k?.reported) cameBack.push(id)
      known.set(id, { misses: 0, reported: false })
    }
    for (const id of down) {
      const k = known.get(id)
      if (first) {
        known.set(id, { misses: this.downAfter, reported: true })
        continue
      }
      const misses = (k?.misses ?? 0) + 1
      const report = !k?.reported && misses >= this.downAfter
      if (report) wentDown.push(id)
      known.set(id, { misses, reported: !!k?.reported || report })
    }
    // keys that were deleted
    const listed = new Set([...up, ...down])
    for (const id of known.keys()) if (!listed.has(id)) known.delete(id)
    this.known = known
    if (wentDown.length) await this.notifier.emit('minion_down', minionsDownMessage(wentDown.sort()))
    if (cameBack.length) await this.notifier.emit('minion_down', minionsUpMessage(cameBack.sort()))
  }
}
