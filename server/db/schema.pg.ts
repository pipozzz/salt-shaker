import { boolean, index, integer, pgTable, primaryKey, serial, text, timestamp } from 'drizzle-orm/pg-core'

// Postgres twin of schema.sqlite.ts — keep the two in sync.
// Better Auth core tables + the username and admin plugins (see getAuthTables()).
export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  username: text('username').unique(),
  displayUsername: text('display_username'),
  role: text('role'),
  banned: boolean('banned').default(false),
  banReason: text('ban_reason'),
  banExpires: timestamp('ban_expires', { withTimezone: true }),
  /** set by Salt Shaker on every successful sign-in, for access reviews */
  lastSignInAt: timestamp('last_sign_in_at', { withTimezone: true }),
})

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  impersonatedBy: text('impersonated_by'),
})

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
})

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
})

/** Every call that could change something, who made it, and how it ended. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: serial('id').primaryKey(),
    at: timestamp('at', { withTimezone: true }).notNull(),
    userId: text('user_id'),
    username: text('username').notNull(),
    role: text('role'),
    client: text('client').notNull(),
    fun: text('fun').notNull(),
    target: text('target'),
    targetType: text('target_type'),
    args: text('args'),
    jid: text('jid'),
    outcome: text('outcome').notNull(),
    error: text('error'),
    ip: text('ip'),
  },
  (t) => [index('audit_log_at_idx').on(t.at), index('audit_log_username_idx').on(t.username)],
)

/** Jobs seen on the master's event bus, kept beyond the master's own keep_jobs window. */
export const job = pgTable(
  'job',
  {
    jid: text('jid').primaryKey(),
    fun: text('fun').notNull(),
    args: text('args'),
    target: text('target'),
    targetType: text('target_type'),
    saltUser: text('salt_user'),
    // from job metadata: the Salt Shaker user who started it (null for CLI and other tools)
    shakerUser: text('shaker_user'),
    minions: text('minions'),
    dryRun: boolean('dry_run').notNull().default(false),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('job_started_at_idx').on(t.startedAt), index('job_fun_idx').on(t.fun)],
)

export const jobReturn = pgTable(
  'job_return',
  {
    jid: text('jid').notNull(),
    minion: text('minion').notNull(),
    ret: text('ret'),
    retcode: integer('retcode'),
    success: boolean('success'),
    // for state runs: {ok, changed, pending, failed}, so history doesn't have to parse ret
    summary: text('summary'),
    returnedAt: timestamp('returned_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.jid, t.minion] })],
)

/** Recurring jobs the server starts on a cron schedule (compliance checks, patch scans, any function). */
export const schedule = pgTable('schedule', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().unique(),
  kind: text('kind').notNull(),
  fun: text('fun'),
  args: text('args'),
  target: text('target').notNull(),
  targetType: text('target_type').notNull(),
  cron: text('cron').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  // claimed atomically before each run, so several server instances never run it twice
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  lastJid: text('last_jid'),
  lastSummary: text('last_summary'),
})

/** Where alerts go: a Slack-compatible incoming webhook or a generic JSON webhook. */
export const notificationChannel = pgTable('notification_channel', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind').notNull(),
  url: text('url').notNull(),
  events: text('events').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  // JSON webhooks are signed with it (HMAC-SHA256), so the receiver can tell they're ours
  secret: text('secret'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  lastSentAt: timestamp('last_sent_at', { withTimezone: true }),
  lastError: text('last_error'),
})

/** Leader election: one row per role (e.g. "events"), held by one server instance until it expires. */
export const lease = pgTable('lease', {
  name: text('name').primaryKey(),
  holder: text('holder').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
})

/** Named targets the whole team picks from in Run, Schedules and the command palette. */
export const savedTarget = pgTable('saved_target', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().unique(),
  target: text('target').notNull(),
  targetType: text('target_type').notNull(),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
})

export const osvPackage = pgTable(
  'osv_package',
  {
    ecosystem: text('ecosystem').notNull(),
    name: text('name').notNull(),
    version: text('version').notNull(),
    vulns: text('vulns').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.ecosystem, t.name, t.version] })],
)

export const osvVuln = pgTable('osv_vuln', {
  id: text('id').primaryKey(),
  modified: text('modified').notNull(),
  data: text('data').notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
})

/** Vulnerabilities the team accepted the risk of: left out of counts, alerts and Patches until they expire. */
export const vulnAcceptance = pgTable('vuln_acceptance', {
  vulnId: text('vuln_id').primaryKey(),
  note: text('note').notNull(),
  acceptedBy: text('accepted_by'),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  // when the "ends soon" and "ended" notifications went out, so each goes out once
  warnedAt: timestamp('warned_at', { withTimezone: true }),
  endedNotifiedAt: timestamp('ended_notified_at', { withTimezone: true }),
})

/** The vulnerability report's totals, one row per day (UTC), for the trend on the Vulnerabilities page. */
export const vulnDaily = pgTable('vuln_daily', {
  day: text('day').primaryKey(),
  critical: integer('critical').notNull(),
  high: integer('high').notNull(),
  medium: integer('medium').notNull(),
  low: integer('low').notNull(),
  unknown: integer('unknown').notNull(),
  fixable: integer('fixable').notNull(),
  minions: integer('minions').notNull(),
  affected: integer('affected').notNull(),
})

/** osquery queries the team saved, offered on the Query page next to the built-in library. */
export const savedQuery = pgTable('saved_query', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().unique(),
  sql: text('sql').notNull(),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
})

/** Limits what a user may run on to the minions a target matches (admins set it; none: the whole fleet). */
export const userScope = pgTable('user_scope', {
  userId: text('user_id').primaryKey(),
  target: text('target').notNull(),
  targetType: text('target_type').notNull(),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
})

/**
 * A change: one function on a target, run in batches with a stop on failures, and, when the policy
 * says so, only after an admin approved it. Batches: JSON [{jid, minions, startedAt}].
 */
export const change = pgTable('change', {
  id: serial('id').primaryKey(),
  reason: text('reason').notNull(),
  target: text('target').notNull(),
  targetType: text('target_type').notNull(),
  fun: text('fun').notNull(),
  args: text('args').notNull(),
  batchSize: text('batch_size'),
  maxFailures: integer('max_failures').notNull().default(0),
  status: text('status').notNull(),
  requestedBy: text('requested_by').notNull(),
  requestedById: text('requested_by_id'),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
  decidedBy: text('decided_by'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decisionNote: text('decision_note'),
  minions: text('minions'),
  batches: text('batches').notNull().default('[]'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  error: text('error'),
})

/** Personal API tokens for scripts and CI; only a hash of each is kept. */
export const apiToken = pgTable('api_token', {
  id: serial('id').primaryKey(),
  userId: text('user_id').notNull(),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  prefix: text('prefix').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
})

/** A window in which new minions whose id matches are accepted without a click (at most maxAccepts). */
export const keyRule = pgTable('key_rule', {
  id: serial('id').primaryKey(),
  pattern: text('pattern').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  maxAccepts: integer('max_accepts').notNull(),
  accepted: text('accepted').notNull().default('[]'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
})
