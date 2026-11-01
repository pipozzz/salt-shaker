import { eq } from 'drizzle-orm'
import type { Db, Schema } from './db'
import type { JobRet } from './history'
import { jobFailedMessage, pendingKeyMessage, type Message } from './summaries'

export const EVENTS = {
  drift: 'A scheduled compliance check found drift or errors',
  patches: 'A scheduled patch scan found upgrades',
  schedule: 'Any scheduled run finished',
  job_failed: 'A job failed on any minion',
  pending_key: 'A new minion is waiting for key approval',
} as const
export type NotifyEvent = keyof typeof EVENTS
export const isEvent = (e: unknown): e is NotifyEvent => typeof e === 'string' && e in EVENTS

export const CHANNEL_KINDS = ['slack', 'webhook'] as const
export type ChannelKind = (typeof CHANNEL_KINDS)[number]

const ICON = { info: 'ℹ️', warning: '⚠️', error: '🔴' }

/** The HTTP body for a channel: Slack's incoming-webhook format, or plain JSON for anything else. */
export function payloadFor(kind: string, event: NotifyEvent, msg: Message, publicUrl: string) {
  const url = msg.path ? `${publicUrl}${msg.path}` : publicUrl
  if (kind === 'slack') {
    return { text: `${ICON[msg.severity]} *${msg.title}*\n${msg.lines.join('\n')}\n<${url}|Open in Salt Shaker>` }
  }
  return { source: 'salt-shaker', event, severity: msg.severity, title: msg.title, lines: msg.lines, url, at: new Date().toISOString() }
}

// how long to collect failing minions of one job before sending a single alert
const FAILURE_WINDOW_MS = 15_000
// don't alert again about the same pending key for a while (minions re-knock every ~10s)
const PENDING_KEY_QUIET_MS = 6 * 3600_000

export class Notifier {
  private db: Db
  private schema: Schema
  private publicUrl: string
  private failures = new Map<string, { fun: string; by: string | null; minions: Set<string> }>()
  private pendingSeen = new Map<string, number>()

  constructor(db: Db, schema: Schema, publicUrl: string) {
    this.db = db
    this.schema = schema
    this.publicUrl = publicUrl
  }

  /** Sends to every enabled channel subscribed to the event; never throws. */
  async emit(event: NotifyEvent, msg: Message) {
    const t = this.schema.notificationChannel
    const channels = await this.db.select().from(t).where(eq(t.enabled, true))
    await Promise.all(
      channels
        .filter((ch) => (JSON.parse(ch.events) as string[]).includes(event))
        .map((ch) => this.send(ch.id, ch.kind, ch.url, event, msg)),
    )
  }

  /** Posts one message to one channel and records the outcome on it. */
  async send(id: number, kind: string, url: string, event: NotifyEvent, msg: Message): Promise<string | null> {
    const t = this.schema.notificationChannel
    let error: string | null = null
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'salt-shaker' },
        body: JSON.stringify(payloadFor(kind, event, msg, this.publicUrl)),
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) error = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
    try {
      await this.db.update(t).set(error ? { lastError: error } : { lastSentAt: new Date(), lastError: null }).where(eq(t.id, id))
    } catch {
      // the channel may have been deleted meanwhile
    }
    if (error) console.warn(`notify: channel ${id} failed: ${error}`)
    return error
  }

  /** Fed by the history recorder for every job return. */
  onReturn(r: JobRet) {
    if ((r.retcode ?? 0) === 0 && r.success !== false) return
    // scheduled runs report through their own summary instead
    if (r.shakerUser?.startsWith('schedule:')) return
    const pending = this.failures.get(r.jid)
    if (pending) {
      pending.minions.add(r.minion)
      return
    }
    this.failures.set(r.jid, { fun: r.fun, by: r.shakerUser ?? r.saltUser, minions: new Set([r.minion]) })
    setTimeout(() => {
      const f = this.failures.get(r.jid)
      this.failures.delete(r.jid)
      if (f) void this.emit('job_failed', jobFailedMessage(f.fun, [...f.minions].sort(), f.by, r.jid))
    }, FAILURE_WINDOW_MS)
  }

  /** Fed with every master event; reacts to minions knocking with an unaccepted key. */
  onEvent(tag: string, data: Record<string, unknown>) {
    if (tag !== 'salt/auth' || data.act !== 'pend' || typeof data.id !== 'string') return
    const last = this.pendingSeen.get(data.id) ?? 0
    if (Date.now() - last < PENDING_KEY_QUIET_MS) return
    this.pendingSeen.set(data.id, Date.now())
    void this.emit('pending_key', pendingKeyMessage(data.id))
  }
}
