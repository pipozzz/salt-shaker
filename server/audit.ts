import { and, eq, gte, like, lt, or, sql } from 'drizzle-orm'
import { toCsv } from '../src/lib/csv'
import type { Db, Schema } from './db'

export interface AuditFilter {
  q?: string
  outcome?: string
  /** inclusive, as YYYY-MM-DD (UTC) */
  from?: string
  /** inclusive, as YYYY-MM-DD (UTC) */
  to?: string
  /** only entries older than this id (paging) */
  before?: number | null
}

const OUTCOMES = new Set(['ok', 'denied', 'error'])
const day = (s: string | undefined) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) ? new Date(`${s}T00:00:00Z`) : null)

/** Reads the filter from query parameters, ignoring values that don't parse. */
export function auditFilter(query: (k: string) => string | undefined): AuditFilter {
  const outcome = query('outcome')
  return {
    q: query('q')?.trim() || undefined,
    outcome: outcome && OUTCOMES.has(outcome) ? outcome : undefined,
    from: day(query('from')) ? query('from') : undefined,
    to: day(query('to')) ? query('to') : undefined,
    before: Number(query('before')) || null,
  }
}

/** The WHERE clause for a filter. */
export function auditWhere(schema: Schema, f: AuditFilter) {
  const t = schema.auditLog
  const from = day(f.from)
  const to = day(f.to)
  return and(
    f.before ? lt(t.id, f.before) : undefined,
    // lower() on both sides: LIKE is case-insensitive in SQLite but not in Postgres
    f.q ? or(...[t.username, t.fun, t.target].map((col) => like(sql`lower(${col})`, `%${f.q!.toLowerCase()}%`)), eq(t.jid, f.q)) : undefined,
    f.outcome ? eq(t.outcome, f.outcome) : undefined,
    from ? gte(t.at, from) : undefined,
    to ? lt(t.at, new Date(to.getTime() + 86400_000)) : undefined,
  )
}

/** Deletes audit entries older than `days`; 0 keeps everything. Returns how many went. */
export async function pruneAudit(db: Db, schema: Schema, days: number, now = new Date()) {
  if (days <= 0) return 0
  const t = schema.auditLog
  const cutoff = new Date(now.getTime() - days * 86400_000)
  const gone = await db.delete(t).where(lt(t.at, cutoff)).returning({ id: t.id })
  return gone.length
}

type Row = Schema['auditLog']['$inferSelect']

/** Audit entries as CSV, one row per call, arguments as JSON. */
export function auditCsv(rows: Row[]) {
  return toCsv([
    ['id', 'at', 'username', 'role', 'client', 'function', 'target', 'target_type', 'arguments', 'jid', 'outcome', 'error', 'ip'],
    ...rows.map((r) => [r.id, r.at.toISOString(), r.username, r.role, r.client, r.fun, r.target, r.targetType, r.args, r.jid, r.outcome, r.error, r.ip]),
  ])
}
