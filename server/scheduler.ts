import { Cron } from 'croner'
import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm'
import type { Db, Schema } from './db'
import { INVENTORY_KWARG, INVENTORY_SCRIPT } from '../src/lib/inventory'
import { osqueryCall } from '../src/lib/osquery'
import { osqueryDiff, osqueryMessage } from './osquery'
import { isDryRun } from './history'
import type { Notifier } from './notify'
import type { SaltService } from './salt'
import { acceptanceMessages, complianceCounts, complianceMessage, driftedMinions, failureSummary, functionMessage, patchMessage, patchSummary, vulnMessage } from './summaries'
import { vulnScanSummary, type VulnService } from './vulns'
import { loadWindows } from './windows'
import { nextOpening, openingAt, type MaintenanceWindow } from '../src/lib/windows'

export const SCHEDULE_KINDS = {
  compliance: 'Compliance check (state.apply test=True)',
  patches: 'Patch scan (pkg.list_upgrades)',
  vulns: 'Vulnerability scan (package inventory)',
  osquery: 'osquery query (alert on changes)',
  function: 'Any function',
} as const
export type ScheduleKind = keyof typeof SCHEDULE_KINDS

type ScheduleRow = Schema['schedule']['$inferSelect']

/** Throws a readable error for an invalid cron expression; returns the next run otherwise. */
export function nextRun(cron: string, from = new Date()) {
  return new Cron(cron, { paused: true }).nextRun(from)
}

/** When a schedule is next due: the first cron slot after its last run (or its creation). */
export function dueAt(s: Pick<ScheduleRow, 'cron' | 'lastRunAt' | 'createdAt'>) {
  return nextRun(s.cron, s.lastRunAt ?? s.createdAt)
}

/** When it actually runs: its cron slot, or when its maintenance window next opens after that. */
export function runsAt(s: Pick<ScheduleRow, 'cron' | 'lastRunAt' | 'createdAt'>, window?: MaintenanceWindow) {
  const due = dueAt(s)
  if (!due || !window || openingAt(window, due)) return due
  return nextOpening(window, due)?.start ?? null
}

/** The salt-api lowstate a schedule runs. */
export function lowstateFor(s: Pick<ScheduleRow, 'id' | 'name' | 'kind' | 'fun' | 'args' | 'target' | 'targetType'>) {
  const base = {
    client: 'local_async',
    tgt: s.target,
    tgt_type: s.targetType,
    metadata: { salt_shaker_user: `schedule:${s.name}`, salt_shaker_schedule: s.id },
  }
  if (s.kind === 'compliance') return { ...base, fun: 'state.apply', arg: [], kwarg: { test: true } }
  if (s.kind === 'patches') return { ...base, fun: 'pkg.list_upgrades', arg: [], kwarg: { refresh: true } }
  if (s.kind === 'vulns') return { ...base, fun: 'cmd.run', arg: [INVENTORY_SCRIPT], kwarg: { ...INVENTORY_KWARG } }
  const args = s.args ? (JSON.parse(s.args) as { arg?: unknown[]; kwarg?: Record<string, unknown>; sql?: string }) : {}
  if (s.kind === 'osquery') {
    const call = osqueryCall(args.sql ?? 'SELECT 1;')
    return { ...base, fun: 'cmd.run', arg: call.arg, kwarg: call.kwarg as Record<string, unknown> }
  }
  return { ...base, fun: s.fun ?? 'test.ping', arg: args.arg ?? [], kwarg: args.kwarg ?? {} }
}

/** How a compliance schedule fixes the drift it finds: a change in batches, stopped by failures. */
export interface Remedy {
  batchSize: string | null
  maxFailures: number
}

export function readRemedy(json: string | null): Remedy | null {
  if (!json) return null
  try {
    const r = JSON.parse(json) as Partial<Remedy>
    return { batchSize: typeof r.batchSize === 'string' && r.batchSize.trim() ? r.batchSize.trim() : null, maxFailures: Math.max(0, Math.floor(Number(r.maxFailures) || 0)) }
  } catch {
    return null
  }
}

const TICK_MS = 20_000
const ACCEPTANCE_CHECK_MS = 5 * 60_000
// give slow highstates time to finish before summarizing what came back
const RESULT_DEADLINE_MS = 15 * 60_000

interface Pending {
  schedule: ScheduleRow
  minions: string[]
  deadline: number
}

export class Scheduler {
  private db: Db
  private schema: Schema
  private salt: SaltService
  private notifier: Notifier
  private audit: (row: { username: string; client: string; fun: string; target: string; targetType: string; jid: string | null; outcome: string; error?: string }) => Promise<unknown>
  private pending = new Map<string, Pending>()
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false

  /** for vulnerability scans: matches the inventories once they're in */
  vulns: VulnService | null = null

  constructor(db: Db, schema: Schema, salt: SaltService, notifier: Notifier, audit: Scheduler['audit']) {
    this.db = db
    this.schema = schema
    this.salt = salt
    this.notifier = notifier
    this.audit = audit
  }

  start() {
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    void this.tick()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
  }

  async tick() {
    if (this.ticking) return
    this.ticking = true
    try {
      const t = this.schema.schedule
      const now = new Date()
      const windows = new Map((await loadWindows(this.db, this.schema)).map((w) => [w.id, w]))
      for (const s of await this.db.select().from(t).where(eq(t.enabled, true))) {
        let due: Date | null
        try {
          due = dueAt(s)
        } catch {
          continue // invalid cron saved before validation existed; the UI shows it
        }
        if (!due || due > now) continue
        // tied to a window: wait until it opens (missed slots in between run once)
        const window = s.windowId ? windows.get(s.windowId) : undefined
        if (window && !openingAt(window, now)) continue
        // claim this run: only the instance whose update matches the old lastRunAt gets to start it
        const claimed = await this.db
          .update(t)
          .set({ lastRunAt: now })
          .where(and(eq(t.id, s.id), s.lastRunAt ? eq(t.lastRunAt, s.lastRunAt) : isNull(t.lastRunAt)))
          .returning({ id: t.id })
        if (claimed.length) await this.run({ ...s, lastRunAt: now })
      }
      await this.collect()
      await this.checkAcceptances()
    } catch (e) {
      console.warn('scheduler: tick failed', e)
    } finally {
      this.ticking = false
    }
  }

  /** Starts a schedule's job now (from the tick, or "Run now" in the UI). */
  async run(s: ScheduleRow) {
    const low = lowstateFor(s)
    const who = `schedule:${s.name}`
    try {
      const ret = (await this.salt.call(low)) as { jid?: string; minions?: string[] } | ''
      if (!ret || !ret.jid) {
        await this.audit({ username: who, client: 'local_async', fun: low.fun, target: s.target, targetType: s.targetType, jid: null, outcome: 'error', error: 'No minions matched the target' })
        await this.db.update(this.schema.schedule).set({ lastSummary: JSON.stringify({ error: 'No minions matched the target' }) }).where(eq(this.schema.schedule.id, s.id))
        return null
      }
      await this.db.update(this.schema.schedule).set({ lastJid: ret.jid }).where(eq(this.schema.schedule.id, s.id))
      await this.record(ret.jid, low, ret.minions ?? [], who)
      await this.audit({ username: who, client: 'local_async', fun: low.fun, target: s.target, targetType: s.targetType, jid: ret.jid, outcome: 'ok' })
      this.pending.set(ret.jid, { schedule: s, minions: ret.minions ?? [], deadline: Date.now() + RESULT_DEADLINE_MS })
      return ret.jid
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      await this.audit({ username: who, client: 'local_async', fun: low.fun, target: s.target, targetType: s.targetType, jid: null, outcome: 'error', error })
      await this.db.update(this.schema.schedule).set({ lastSummary: JSON.stringify({ error }) }).where(eq(this.schema.schedule.id, s.id))
      return null
    }
  }

  /**
   * Stores the job right away, so the history has it even for functions it otherwise skips
   * (e.g. test.ping) and before the master's "new" event arrives.
   */
  private async record(jid: string, low: ReturnType<typeof lowstateFor>, minions: string[], who: string) {
    const job = this.schema.job
    // same shape as the master's events: keyword arguments last, marked with __kwarg__
    const args: unknown[] = [...low.arg, ...(Object.keys(low.kwarg).length ? [{ __kwarg__: true, ...low.kwarg }] : [])]
    await this.db
      .insert(job)
      .values({ jid, fun: low.fun, args: JSON.stringify(args), target: low.tgt, targetType: low.tgt_type, shakerUser: who, minions: JSON.stringify(minions), dryRun: isDryRun(args), startedAt: new Date() })
      .onConflictDoNothing()
    await this.db.update(job).set({ shakerUser: who }).where(and(eq(job.jid, jid), isNull(job.shakerUser)))
  }

  /**
   * A compliance schedule with a remedy applies the highstate to the minions it found drifted, as a
   * change: in batches, stopped when too many fail, on the Changes page. Minions with errors are
   * left for a person. Nothing starts outside the schedule's window, or while its last fix runs.
   */
  private async remediate(s: ScheduleRow, rows: Array<{ minion: string; summary: string | null }>, jid: string) {
    const remedy = readRemedy(s.remedy)
    if (!remedy) return null
    const drifted = driftedMinions(rows)
    if (!drifted.length) return null
    const window = s.windowId ? (await loadWindows(this.db, this.schema)).find((w) => w.id === s.windowId) : undefined
    if (window && !openingAt(window, new Date())) return { remedySkipped: `the window ${window.name} has closed` }
    const t = this.schema.change
    const who = `schedule:${s.name}`
    const [running] = await this.db.select({ id: t.id }).from(t).where(and(eq(t.requestedBy, who), inArray(t.status, ['pending', 'queued', 'running'])))
    if (running) return { remedySkipped: `its last fix, change #${running.id}, hasn't finished` }
    const target = drifted.join(',')
    const [row] = await this.db
      .insert(t)
      .values({
        reason: `Fix the drift that "${s.name}" found (job ${jid})`,
        target,
        targetType: 'list',
        fun: 'state.apply',
        args: JSON.stringify({ arg: [], kwarg: {} }),
        batchSize: remedy.batchSize,
        maxFailures: remedy.maxFailures,
        status: 'queued',
        requestedBy: who,
        requestedAt: new Date(),
      })
      .returning({ id: t.id })
    await this.audit({ username: who, client: 'change', fun: 'change.request', target: `#${row.id} state.apply → ${target}`, targetType: 'list', jid: null, outcome: 'ok' })
    return { remedyChange: row.id, remedyMinions: drifted.length }
  }

  private acceptancesCheckedAt = 0

  /** Announces accepted risks that end soon or have ended; every few minutes is plenty. */
  async checkAcceptances(force = false) {
    if (!this.vulns || (!force && Date.now() - this.acceptancesCheckedAt < ACCEPTANCE_CHECK_MS)) return
    this.acceptancesCheckedAt = Date.now()
    const { soon, ended } = await this.vulns.acceptanceNotices()
    for (const msg of acceptanceMessages(soon, ended)) await this.notifier.emit('acceptance', msg)
  }

  /** The returns of the schedule's run before `jid`, to compare a query's rows with. */
  private async previousReturns(name: string, jid: string) {
    const j = this.schema.job
    const [prev] = await this.db
      .select({ jid: j.jid })
      .from(j)
      .where(and(eq(j.shakerUser, `schedule:${name}`), ne(j.jid, jid)))
      .orderBy(desc(j.startedAt))
      .limit(1)
    if (!prev) return null
    const r = this.schema.jobReturn
    return this.db.select({ minion: r.minion, ret: r.ret }).from(r).where(eq(r.jid, prev.jid))
  }

  private async summarizeVulns(s: ScheduleRow, jid: string, expected: number, target: string) {
    try {
      const { report, updating } = await this.vulns!.get(10 * 60_000)
      if (!report || updating) throw new Error('Matching the packages against OSV.dev took too long')
      const summary = vulnScanSummary(report, jid, expected)
      const msg = vulnMessage(s.name, target, summary, report.error)
      if (summary.fixable > 0) await this.notifier.emit('vulns', msg)
      await this.notifier.emit('schedule', msg)
      await this.db.update(this.schema.schedule).set({ lastSummary: JSON.stringify(summary) }).where(eq(this.schema.schedule.id, s.id))
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      await this.db.update(this.schema.schedule).set({ lastSummary: JSON.stringify({ error }) }).where(eq(this.schema.schedule.id, s.id))
    }
  }

  /** Summarizes runs whose minions have all returned (or that hit the deadline) and notifies. */
  private async collect() {
    for (const [jid, p] of this.pending) {
      const rows = await this.db.select().from(this.schema.jobReturn).where(eq(this.schema.jobReturn.jid, jid))
      if (rows.length < p.minions.length && Date.now() < p.deadline) continue
      this.pending.delete(jid)
      const s = p.schedule
      const target = `${s.targetType !== 'glob' ? `${s.targetType}:` : ''}${s.target}`
      let summary: unknown
      if (s.kind === 'compliance') {
        const c = complianceCounts(rows, p.minions.length)
        const remedy = await this.remediate(s, rows, jid)
        summary = { ...c, ...(remedy ?? {}) }
        const msg = complianceMessage(s.name, target, c, jid)
        if (remedy && 'remedyChange' in remedy) msg.lines.push(`Fixing ${remedy.remedyMinions} drifted ${remedy.remedyMinions === 1 ? 'minion' : 'minions'} in change #${remedy.remedyChange}`)
        if (remedy && 'remedySkipped' in remedy) msg.lines.push(`Not fixed: ${remedy.remedySkipped}`)
        if (c.drift + c.error > 0) await this.notifier.emit('drift', msg)
        await this.notifier.emit('schedule', msg)
      } else if (s.kind === 'patches') {
        const ps = patchSummary(rows, p.minions.length)
        summary = ps
        const msg = patchMessage(s.name, target, ps, jid)
        if (ps.needUpdates > 0) await this.notifier.emit('patches', msg)
        await this.notifier.emit('schedule', msg)
      } else if (s.kind === 'osquery') {
        const d = osqueryDiff(await this.previousReturns(s.name, jid), rows, p.minions.length)
        summary = d
        const msg = osqueryMessage(s.name, target, d, jid)
        if (!d.baseline && d.added + d.removed > 0) await this.notifier.emit('osquery', msg)
        await this.notifier.emit('schedule', msg)
      } else if (s.kind === 'vulns' && this.vulns) {
        // matching against OSV.dev can take a while the first time; don't hold up other schedules
        void this.summarizeVulns(s, jid, p.minions.length, target)
        continue
      } else {
        const f = failureSummary(rows, p.minions.length)
        summary = { returned: f.returned, failed: f.failed.length, noreturn: f.noreturn }
        await this.notifier.emit('schedule', functionMessage(s.name, s.fun ?? '?', target, f, jid))
      }
      await this.db.update(this.schema.schedule).set({ lastSummary: JSON.stringify(summary) }).where(eq(this.schema.schedule.id, s.id))
    }
  }
}
