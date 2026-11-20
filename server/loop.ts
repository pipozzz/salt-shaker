/**
 * How late this process gets to things: a timer that should fire every `intervalMs` notes how
 * much later it ran. A long synchronous stretch (a big SQLite write, a huge JSON answer) shows up
 * as one late tick, and every request waiting behind it was that late too.
 */
export class LoopDelay {
  private intervalMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  private expected = 0
  private worst = 0

  constructor(intervalMs = 500) {
    this.intervalMs = intervalMs
  }

  start() {
    if (this.timer) return
    this.expected = performance.now() + this.intervalMs
    this.timer = setInterval(() => {
      const now = performance.now()
      this.worst = Math.max(this.worst, now - this.expected)
      this.expected = now + this.intervalMs
    }, this.intervalMs)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** The longest delay, in seconds, since the last call (each scrape gets its own window). */
  takeMax() {
    const worst = this.worst
    this.worst = 0
    return Math.max(0, worst) / 1000
  }
}
