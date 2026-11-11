import { and, asc, count, countDistinct, desc, eq, gte, inArray, isNotNull, lte, ne, or } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Db, Schema } from './db'
import { reportMessage, type ReportStats } from '../src/lib/report'
import type { Message } from './summaries'
import type { Env } from './types'

/*
 * The weekly report: how the fleet did over the last seven days, in a few lines for the people who
 * don't open the console every day. Sent on Mondays at 8:00 (the server's time zone) to the
 * channels that subscribe to it, by the instance that follows the event bus.
 */

const DAY = 86400_000
const HOUR = 3600_000
// how long a minion may go without answering the presence check before it counts as not answering
const ANSWER_WITHIN_MS = HOUR
const QUIET_DAYS = 30

export { reportMessage, type ReportStats }

/** The numbers for the seven days up to `now`, from what the server keeps. */
export async function reportStats(db: Db, schema: Schema, accepted: string[], now = new Date()): Promise<ReportStats> {
  const from = new Date(+now - 7 * DAY)
  const { job, jobReturn, change, vulnDaily, auditLog, minionSeen } = schema

  const seenRows = await db.select().from(minionSeen)
  const seen = new Map(seenRows.map((r) => [r.minion, +new Date(r.lastSeenAt)]))
  const since = seenRows.length ? Math.min(...seen.values()) : null
  const notAnswering = since === null ? null : accepted.filter((id) => (seen.get(id) ?? 0) < +now - ANSWER_WITHIN_MS).length
  const quietCutoff = +now - QUIET_DAYS * DAY
  const quiet = since === null ? null : accepted.filter((id) => (seen.has(id) ? seen.get(id)! < quietCutoff : since < quietCutoff)).length

  const [{ run }] = await db.select({ run: count() }).from(job).where(gte(job.startedAt, from))
  const [{ failed }] = await db
    .select({ failed: countDistinct(jobReturn.jid) })
    .from(jobReturn)
    .innerJoin(job, eq(job.jid, jobReturn.jid))
    .where(and(gte(job.startedAt, from), or(ne(jobReturn.retcode, 0), eq(jobReturn.success, false))))

  const finished = await db
    .select({ status: change.status, k: count() })
    .from(change)
    .where(and(isNotNull(change.finishedAt), gte(change.finishedAt, from)))
    .groupBy(change.status)
  const byStatus = Object.fromEntries(finished.map((r) => [r.status, Number(r.k)]))
  const [{ waiting }] = await db.select({ waiting: count() }).from(change).where(eq(change.status, 'pending'))

  const [latest] = await db.select().from(vulnDaily).orderBy(desc(vulnDaily.day)).limit(1)
  const weekAgo = from.toISOString().slice(0, 10)
  const [before] = latest ? await db.select().from(vulnDaily).where(lte(vulnDaily.day, weekAgo)).orderBy(desc(vulnDaily.day)).limit(1) : []
  // the earliest day in the week stands in when nothing is a week old yet
  const [earliest] = latest && !before ? await db.select().from(vulnDaily).where(gte(vulnDaily.day, weekAgo)).orderBy(asc(vulnDaily.day)).limit(1) : []
  const base = before ?? (earliest && earliest.day !== latest?.day ? earliest : null)

  const [commands] = await db
    .select({ count: count(), people: countDistinct(auditLog.username) })
    .from(auditLog)
    .where(and(gte(auditLog.at, from), inArray(auditLog.client, ['local', 'local_async', 'runner', 'runner_async', 'wheel', 'change'])))

  return {
    from,
    to: now,
    minions: { accepted: accepted.length, notAnswering, quiet },
    jobs: { run: Number(run), failed: Number(failed) },
    changes: { done: byStatus.done ?? 0, stopped: (byStatus.stopped ?? 0) + (byStatus.failed ?? 0), waiting: Number(waiting) },
    vulns: latest ? { critical: latest.critical, high: latest.high, fixable: latest.fixable, criticalBefore: base?.critical ?? null, highBefore: base?.high ?? null } : null,
    commands: { count: Number(commands.count), people: Number(commands.people) },
  }
}

/** The ISO week a date falls in, e.g. 2026-W46: the report goes out once per week. */
export function isoWeek(d: Date) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day)
  const year = t.getUTCFullYear()
  const week = Math.ceil(((+t - Date.UTC(year, 0, 1)) / DAY + 1) / 7)
  return `${year}-W${String(week).padStart(2, '0')}`
}

/** Monday from 8:00 on, server time: when this week's report is due. */
export const reportDue = (d: Date) => (d.getDay() === 1 && d.getHours() >= 8) || d.getDay() === 0 || d.getDay() > 1

interface Deps {
  db: Db
  schema: Schema
  accepted: () => Promise<string[] | null>
  send: (msg: Message) => Promise<unknown>
  now?: () => Date
}

const MARK = 'report:weekly'

export class WeeklyReport {
  private timer: ReturnType<typeof setInterval> | null = null
  private now: () => Date
  constructor(private d: Deps) {
    this.now = d.now ?? (() => new Date())
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), 10 * 60_000)
    void this.tick()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Sends this week's report once it's due and hasn't gone out; the week is marked first, so it goes out once. */
  async tick() {
    const now = this.now()
    if (!reportDue(now)) return false
    const week = isoWeek(now)
    const t = this.d.schema.lease
    const [mark] = await this.d.db.select().from(t).where(eq(t.name, MARK))
    if (mark?.holder === week) return false
    // a server that starts mid-week doesn't send last Monday's report late: it marks the week and waits
    const late = now.getDay() !== 1
    const claimed = mark
      ? await this.d.db.update(t).set({ holder: week }).where(and(eq(t.name, MARK), eq(t.holder, mark.holder))).returning()
      : await this.d.db.insert(t).values({ name: MARK, holder: week, expiresAt: new Date(Date.UTC(9999, 0, 1)) }).onConflictDoNothing().returning()
    if (!claimed.length || late) return false
    try {
      await this.send(now)
    } catch (err) {
      console.warn('report: weekly report failed', err)
    }
    return true
  }

  async message(now = this.now()) {
    const accepted = await this.d.accepted()
    if (!accepted) throw new Error("The master didn't list its minions")
    return reportMessage(await reportStats(this.d.db, this.d.schema, accepted, now))
  }

  async send(now = this.now()) {
    const msg = await this.message(now)
    await this.d.send(msg)
    return msg
  }
}

/** Admins: see this week's report as it stands, or send it now to the channels that take it. */
export function reportRoutes({ report }: { report: WeeklyReport }) {
  const r = new Hono<Env>()
  r.use('/reports/*', async (c, next) => {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Not signed in' }, 401)
    if (user.role !== 'admin') return c.json({ error: 'Admins only' }, 403)
    await next()
  })
  r.get('/reports/weekly', async (c) => c.json({ report: await report.message() }))
  r.post('/reports/weekly/send', async (c) => c.json({ report: await report.send() }))
  return r
}
