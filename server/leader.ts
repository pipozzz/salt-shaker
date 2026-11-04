import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { and, eq, lt, or } from 'drizzle-orm'
import type { Db, Schema } from './db'

export const INSTANCE_ID = `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`

/**
 * Lease-based leader election through the database. The holder renews well before the lease
 * expires; if it dies, another instance takes over once the lease runs out.
 */
export class Leader {
  private db: Db
  private schema: Schema
  private name: string
  private ttlMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  private leading = false
  private onAcquire: () => void
  private onLose: () => void
  private holder: string

  constructor(db: Db, schema: Schema, name: string, handlers: { onAcquire: () => void; onLose: () => void }, ttlMs = 30_000, holder = INSTANCE_ID) {
    this.holder = holder
    this.db = db
    this.schema = schema
    this.name = name
    this.ttlMs = ttlMs
    this.onAcquire = handlers.onAcquire
    this.onLose = handlers.onLose
  }

  get isLeader() {
    return this.leading
  }

  /**
   * Who holds the lease now (any instance), or null when nobody does. A live holder renews every
   * ttl/3, so a renewal much older than that means it has stopped and the lease runs out at expiresAt.
   */
  async holderNow(now = new Date()) {
    const t = this.schema.lease
    const [row] = await this.db.select().from(t).where(eq(t.name, this.name))
    if (!row || row.expiresAt <= now) return null
    const renewedAt = new Date(row.expiresAt.getTime() - this.ttlMs)
    return { holder: row.holder, expiresAt: row.expiresAt, renewedAt, stale: now.getTime() - renewedAt.getTime() > this.ttlMs / 2 }
  }

  start() {
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.ttlMs / 3)
  }

  /** Takes the lease if it is free, expired or already ours; returns whether we hold it. */
  async tryAcquire(now = new Date()) {
    const t = this.schema.lease
    const expiresAt = new Date(now.getTime() + this.ttlMs)
    const rows = await this.db
      .insert(t)
      .values({ name: this.name, holder: this.holder, expiresAt })
      .onConflictDoUpdate({
        target: t.name,
        set: { holder: this.holder, expiresAt },
        setWhere: or(eq(t.holder, this.holder), lt(t.expiresAt, now)),
      })
      .returning({ holder: t.holder })
    return rows[0]?.holder === this.holder
  }

  private async tick() {
    let holds = false
    try {
      holds = await this.tryAcquire()
    } catch (e) {
      console.warn(`leader(${this.name}): lease check failed`, e instanceof Error ? e.message : e)
    }
    if (holds && !this.leading) {
      this.leading = true
      console.log(`leader(${this.name}): this instance (${this.holder}) took over`)
      this.onAcquire()
    } else if (!holds && this.leading) {
      this.leading = false
      console.log(`leader(${this.name}): lost the lease`)
      this.onLose()
    }
  }

  /** Gives the lease up on shutdown so another instance can take over right away. */
  async stop() {
    if (this.timer) clearInterval(this.timer)
    if (this.leading) {
      this.leading = false
      this.onLose()
      const t = this.schema.lease
      await this.db
        .delete(t)
        .where(and(eq(t.name, this.name), eq(t.holder, this.holder)))
        .catch(() => undefined)
    }
  }
}
