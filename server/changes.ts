import { and, eq, inArray } from 'drizzle-orm'
import { batchCount, validBatchSize } from '../src/lib/batch'
import { isRisky } from '../src/lib/risk'
import type { Db, Schema } from './db'
import { isDryRun } from './history'
import type { Notifier } from './notify'
import { checkScope, loadScope, type Expand } from './scope'
import { failureSummary, type Message } from './summaries'
import type { AuditRow } from './types'

/*
 * Changes: one function on a target, run batch by batch, stopped when too many minions fail, and,
 * when APPROVAL_REQUIRED=risky, started only after an admin other than the requester approved it.
 *
 *   pending ──approve──▶ queued ──▶ running ──▶ done
 *      └──reject──▶ rejected          └──▶ stopped (too many failures, or someone stopped it)
 *                                       └──▶ failed (nothing to run on, or salt-api refused)
 *
 * The runner works from the database, so any server instance can pick up where another left off,
 * and each step is claimed with a conditional update, so two instances never start the same batch.
 */

export type ChangeStatus = 'pending' | 'rejected' | 'queued' | 'running' | 'done' | 'stopped' | 'failed'
export interface Batch {
  /** null while the batch is being started */
  jid: string | null
  minions: string[]
  startedAt: string
}
type ChangeRow = Schema['change']['$inferSelect']

/** A batch has had this long to return; minions that didn't count as failed. */
export const BATCH_DEADLINE_MS = 15 * 60_000

export { batchCount, validBatchSize }

/** Whether the policy wants an admin to approve this call before it runs. */
export function needsApproval(policy: 'off' | 'risky', role: string | null | undefined, fun: string, kwarg: Record<string, unknown>) {
  if (policy === 'off' || role === 'admin') return false
  const test = kwarg.test === true || kwarg.test === 'True' || kwarg.test === 'true'
  return isRisky(fun, test ? 'test=True' : '')
}

const describe = (c: Pick<ChangeRow, 'fun' | 'target' | 'targetType'>) => `${c.fun} on ${c.targetType === 'glob' ? '' : `${c.targetType}:`}${c.target}`

export function changeMessage(c: ChangeRow, what: 'pending' | 'done' | 'stopped' | 'failed', detail?: string): Message {
  const title =
    what === 'pending'
      ? `Change #${c.id} waits for approval: ${describe(c)}`
      : what === 'done'
        ? `Change #${c.id} finished: ${describe(c)}`
        : what === 'stopped'
          ? `Change #${c.id} stopped: ${describe(c)}`
          : `Change #${c.id} failed: ${describe(c)}`
  return {
    title,
    lines: [`Requested by ${c.requestedBy}: ${c.reason}`, ...(detail ? [detail] : [])],
    severity: what === 'pending' ? 'warning' : what === 'done' ? 'info' : 'error',
    path: `/changes/${c.id}`,
  }
}

interface Deps {
  db: Db
  schema: Schema
  salt: { call(low: Record<string, unknown>): Promise<unknown> }
  notifier: Pick<Notifier, 'emit'>
  audit: (row: AuditRow) => Promise<unknown>
  expand: Expand
  now?: () => number
}

export class ChangeRunner {
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false
  private now: () => number

  constructor(private d: Deps) {
    this.now = d.now ?? Date.now
  }

  start(intervalMs = 5_000) {
    this.timer = setInterval(() => void this.tick(), intervalMs)
    void this.tick()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
  }

  async tick() {
    if (this.ticking) return
    this.ticking = true
    try {
      const t = this.d.schema.change
      for (const c of await this.d.db.select().from(t).where(inArray(t.status, ['queued', 'running']))) {
        try {
          if (c.status === 'queued') await this.begin(c)
          else await this.step(c)
        } catch (e) {
          console.warn(`changes: #${c.id} failed a step`, e)
        }
      }
    } finally {
      this.ticking = false
    }
  }

  private async finish(c: ChangeRow, status: 'done' | 'stopped' | 'failed', error: string | null) {
    const t = this.d.schema.change
    const done = await this.d.db
      .update(t)
      .set({ status, error, finishedAt: new Date(this.now()) })
      .where(and(eq(t.id, c.id), eq(t.status, c.status)))
      .returning({ id: t.id })
    if (done.length) await this.d.notifier.emit('change', changeMessage(c, status, error ?? undefined))
  }

  /** Works out the minions (again, for a scoped requester, against their scope) and starts. */
  private async begin(c: ChangeRow) {
    const t = this.d.schema.change
    const claimed = await this.d.db.update(t).set({ status: 'running', startedAt: new Date(this.now()) }).where(and(eq(t.id, c.id), eq(t.status, 'queued'))).returning()
    if (!claimed.length) return
    const row = claimed[0]
    let minions = await this.d.expand(c.target, c.targetType)
    const scope = c.requestedById ? await loadScope(this.d.db, this.d.schema, c.requestedById) : null
    if (scope) {
      const ok = await checkScope(scope, { client: 'local_async', fun: c.fun, tgt: c.target, tgt_type: c.targetType }, this.d.expand)
      if (!ok.ok) return this.finish(row, 'failed', ok.reason)
      minions = String(ok.low.tgt).split(',')
    }
    if (!minions.length) return this.finish(row, 'failed', 'The target matches no minions')
    await this.d.db.update(t).set({ minions: JSON.stringify([...minions].sort()) }).where(eq(t.id, c.id))
  }

  /** Waits for the current batch, then stops on too many failures, finishes, or starts the next one. */
  private async step(c: ChangeRow) {
    const t = this.d.schema.change
    const minions = c.minions ? (JSON.parse(c.minions) as string[]) : []
    if (!minions.length) return
    const batches = JSON.parse(c.batches) as Batch[]
    const last = batches[batches.length - 1]
    if (last && !last.jid) return // another instance is starting it

    const progress = await this.progress(batches)
    if (last && !progress.lastDone) return
    if (progress.failed.length > c.maxFailures) {
      return this.finish(c, 'stopped', `${progress.failed.length} ${progress.failed.length === 1 ? 'minion' : 'minions'} failed (${progress.failed.slice(0, 5).join(', ')}${progress.failed.length > 5 ? ', …' : ''}); at most ${c.maxFailures} allowed`)
    }
    const started = batches.reduce((n, b) => n + b.minions.length, 0)
    const next = minions.slice(started, started + batchCount(c.batchSize, minions.length))
    if (!next.length) return this.finish(c, 'done', progress.failed.length ? `${progress.failed.length} failed, within the ${c.maxFailures} allowed` : null)

    // claim the batch before starting it, so only one instance does
    const claimedBatches = [...batches, { jid: null, minions: next, startedAt: new Date(this.now()).toISOString() }]
    const claimed = await this.d.db
      .update(t)
      .set({ batches: JSON.stringify(claimedBatches) })
      .where(and(eq(t.id, c.id), eq(t.batches, c.batches), eq(t.status, 'running')))
      .returning({ id: t.id })
    if (!claimed.length) return
    const args = JSON.parse(c.args) as { arg: unknown[]; kwarg: Record<string, unknown> }
    const low = {
      client: 'local_async',
      tgt: next.join(','),
      tgt_type: 'list',
      fun: c.fun,
      arg: args.arg,
      kwarg: args.kwarg,
      metadata: { salt_shaker_user: c.requestedBy, salt_shaker_change: c.id },
    }
    let jid: string | null = null
    try {
      const ret = (await this.d.salt.call(low)) as { jid?: string } | ''
      jid = ret && ret.jid ? ret.jid : null
    } catch (e) {
      await this.d.db.update(t).set({ batches: c.batches }).where(eq(t.id, c.id))
      return this.finish(c, 'failed', `salt-api refused batch ${batches.length + 1}: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (!jid) {
      await this.d.db.update(t).set({ batches: c.batches }).where(eq(t.id, c.id))
      return this.finish(c, 'failed', `None of batch ${batches.length + 1} answered (${next.join(', ')})`)
    }
    claimedBatches[claimedBatches.length - 1].jid = jid
    await this.d.db.update(t).set({ batches: JSON.stringify(claimedBatches) }).where(eq(t.id, c.id))
    await this.record(jid, low, next, c.requestedBy)
    await this.d.audit({ username: c.requestedBy, role: null, client: 'local_async', fun: c.fun, target: low.tgt, targetType: 'list', args: JSON.stringify({ arg: args.arg, kwarg: args.kwarg, change: c.id }), jid, outcome: 'ok' })
  }

  /** Which minions failed so far (no return by the deadline counts), and whether the last batch is over. */
  async progress(batches: Batch[]) {
    const r = this.d.schema.jobReturn
    const jids = batches.map((b) => b.jid).filter((j): j is string => !!j)
    const rows = jids.length ? await this.d.db.select({ jid: r.jid, minion: r.minion, retcode: r.retcode, success: r.success }).from(r).where(inArray(r.jid, jids)) : []
    const failed: string[] = []
    let lastDone = true
    batches.forEach((b, i) => {
      const mine = rows.filter((x) => x.jid === b.jid)
      const f = failureSummary(mine, b.minions.length)
      const over = mine.length >= b.minions.length || this.now() - Date.parse(b.startedAt) > BATCH_DEADLINE_MS
      if (i === batches.length - 1) lastDone = !!b.jid && over
      failed.push(...f.failed)
      if (over) failed.push(...b.minions.filter((m) => !mine.some((x) => x.minion === m)))
    })
    return { failed: [...new Set(failed)].sort(), lastDone, returns: rows }
  }

  /** The job, in the history right away, like the scheduler's. */
  private async record(jid: string, low: { tgt: string; fun: string; arg: unknown[]; kwarg: Record<string, unknown> }, minions: string[], who: string) {
    const job = this.d.schema.job
    const args: unknown[] = [...low.arg, ...(Object.keys(low.kwarg).length ? [{ __kwarg__: true, ...low.kwarg }] : [])]
    await this.d.db
      .insert(job)
      .values({ jid, fun: low.fun, args: JSON.stringify(args), target: low.tgt, targetType: 'list', shakerUser: who, minions: JSON.stringify(minions), dryRun: isDryRun(args), startedAt: new Date(this.now()) })
      .onConflictDoNothing()
  }
}
