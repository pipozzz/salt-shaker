import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// Better Auth core tables + the username and admin plugins (see getAuthTables()).
export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  username: text('username').unique(),
  displayUsername: text('display_username'),
  role: text('role'),
  banned: integer('banned', { mode: 'boolean' }).default(false),
  banReason: text('ban_reason'),
  banExpires: integer('ban_expires', { mode: 'timestamp_ms' }),
  /** set by Salt Shaker on every successful sign-in, for access reviews */
  lastSignInAt: integer('last_sign_in_at', { mode: 'timestamp_ms' }),
})

export const session = sqliteTable('session', {
  id: text('id').primaryKey(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  impersonatedBy: text('impersonated_by'),
})

export const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
  refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
  scope: text('scope'),
  password: text('password'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

export const verification = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

/** Every call that could change something, who made it, and how it ended. */
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    at: integer('at', { mode: 'timestamp_ms' }).notNull(),
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
export const job = sqliteTable(
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
    dryRun: integer('dry_run', { mode: 'boolean' }).notNull().default(false),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('job_started_at_idx').on(t.startedAt), index('job_fun_idx').on(t.fun)],
)

export const jobReturn = sqliteTable(
  'job_return',
  {
    jid: text('jid').notNull(),
    minion: text('minion').notNull(),
    ret: text('ret'),
    retcode: integer('retcode'),
    success: integer('success', { mode: 'boolean' }),
    // for state runs: {ok, changed, pending, failed}, so history doesn't have to parse ret
    summary: text('summary'),
    returnedAt: integer('returned_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.jid, t.minion] })],
)

/** Recurring jobs the server starts on a cron schedule (compliance checks, patch scans, any function). */
export const schedule = sqliteTable('schedule', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  kind: text('kind').notNull(),
  fun: text('fun'),
  args: text('args'),
  target: text('target').notNull(),
  targetType: text('target_type').notNull(),
  cron: text('cron').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdBy: text('created_by'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  // claimed atomically before each run, so several server instances never run it twice
  lastRunAt: integer('last_run_at', { mode: 'timestamp_ms' }),
  lastJid: text('last_jid'),
  lastSummary: text('last_summary'),
  // waits for this maintenance window when it comes due outside it
  windowId: integer('window_id'),
  // compliance checks: fix the drift they find with a change, JSON {batchSize, maxFailures}; null leaves it
  remedy: text('remedy'),
})

/** Where alerts go: a Slack-compatible incoming webhook or a generic JSON webhook. */
export const notificationChannel = sqliteTable('notification_channel', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  kind: text('kind').notNull(),
  url: text('url').notNull(),
  events: text('events').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  // JSON webhooks are signed with it (HMAC-SHA256), so the receiver can tell they're ours
  secret: text('secret'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  lastSentAt: integer('last_sent_at', { mode: 'timestamp_ms' }),
  lastError: text('last_error'),
})

/** Leader election: one row per role (e.g. "events"), held by one server instance until it expires. */
export const lease = sqliteTable('lease', {
  name: text('name').primaryKey(),
  holder: text('holder').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
})

/** Named targets the whole team picks from in Run, Schedules and the command palette. */
export const savedTarget = sqliteTable('saved_target', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  target: text('target').notNull(),
  targetType: text('target_type').notNull(),
  createdBy: text('created_by'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})

// What OSV.dev said about each installed package version: the ids of the vulnerabilities that
// affect it, with when each was last modified (JSON [{id, modified}]).
export const osvPackage = sqliteTable(
  'osv_package',
  {
    ecosystem: text('ecosystem').notNull(),
    name: text('name').notNull(),
    version: text('version').notNull(),
    vulns: text('vulns').notNull(),
    fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.ecosystem, t.name, t.version] })],
)

// The parts of an OSV vulnerability record the console shows (JSON, see server/vulns.ts).
export const osvVuln = sqliteTable('osv_vuln', {
  id: text('id').primaryKey(),
  modified: text('modified').notNull(),
  data: text('data').notNull(),
  fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' }).notNull(),
})

/** Vulnerabilities the team accepted the risk of: left out of counts, alerts and Patches until they expire. */
export const vulnAcceptance = sqliteTable('vuln_acceptance', {
  vulnId: text('vuln_id').primaryKey(),
  note: text('note').notNull(),
  acceptedBy: text('accepted_by'),
  acceptedAt: integer('accepted_at', { mode: 'timestamp_ms' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
  // when the "ends soon" and "ended" notifications went out, so each goes out once
  warnedAt: integer('warned_at', { mode: 'timestamp_ms' }),
  endedNotifiedAt: integer('ended_notified_at', { mode: 'timestamp_ms' }),
})

/** The vulnerability report's totals, one row per day (UTC), for the trend on the Vulnerabilities page. */
export const vulnDaily = sqliteTable('vuln_daily', {
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
export const savedQuery = sqliteTable('saved_query', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  sql: text('sql').notNull(),
  createdBy: text('created_by'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})

/** Limits what a user may run on to the minions a target matches (admins set it; none: the whole fleet). */
export const userScope = sqliteTable('user_scope', {
  userId: text('user_id').primaryKey(),
  target: text('target').notNull(),
  targetType: text('target_type').notNull(),
  updatedBy: text('updated_by'),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

/**
 * A change: one function on a target, run in batches with a stop on failures, and, when the policy
 * says so, only after an admin approved it. Batches: JSON [{jid, minions, startedAt}].
 */
export const change = sqliteTable('change', {
  id: integer('id').primaryKey({ autoIncrement: true }),
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
  requestedAt: integer('requested_at', { mode: 'timestamp_ms' }).notNull(),
  decidedBy: text('decided_by'),
  decidedAt: integer('decided_at', { mode: 'timestamp_ms' }),
  decisionNote: text('decision_note'),
  minions: text('minions'),
  batches: text('batches').notNull().default('[]'),
  startedAt: integer('started_at', { mode: 'timestamp_ms' }),
  finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
  error: text('error'),
})

/** Personal API tokens for scripts and CI; only a hash of each is kept. */
export const apiToken = sqliteTable('api_token', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: text('user_id').notNull(),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  prefix: text('prefix').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
})

/** A window in which new minions whose id matches are accepted without a click (at most maxAccepts). */
export const keyRule = sqliteTable('key_rule', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  pattern: text('pattern').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  maxAccepts: integer('max_accepts').notNull(),
  accepted: text('accepted').notNull().default('[]'),
  createdBy: text('created_by'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})

/** When each minion last answered the presence check (manage.status), for finding keys of machines that are gone. */
export const minionSeen = sqliteTable('minion_seen', {
  minion: text('minion').primaryKey(),
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull(),
})

/** Which Salt Shaker user a Slack user acts as in /salt commands, linked by that user in the browser. */
export const slackLink = sqliteTable(
  'slack_link',
  {
    team: text('team').notNull(),
    slackUser: text('slack_user').notNull(),
    userId: text('user_id').notNull(),
    slackName: text('slack_name'),
    linkedAt: integer('linked_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.team, t.slackUser] })],
)

/** Other Salt Shaker instances (one per master), for the instance switcher and their summary on the overview. */
export const peer = sqliteTable('peer', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  url: text('url').notNull(),
  // an API token from the other instance, ideally a viewer's: it reads /api/summary there
  token: text('token').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})

/** When changes are expected: weekdays, a local start time and a length, in a timezone. */
export const maintenanceWindow = sqliteTable('maintenance_window', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  // JSON array of weekdays, 0 = Sunday
  days: text('days').notNull(),
  start: text('start').notNull(),
  minutes: integer('minutes').notNull(),
  timezone: text('timezone').notNull(),
  createdBy: text('created_by'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})

/** Runbooks: saved procedures of a few steps with parameters (src/lib/runbook.ts). */
export const runbook = sqliteTable('runbook', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  description: text('description').notNull().default(''),
  // JSON RunbookParam[] and RunbookStep[]
  params: text('params').notNull(),
  steps: text('steps').notNull(),
  createdBy: text('created_by'),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

/** One run of a runbook: its values and how each step went, worked through by the runner. */
export const runbookRun = sqliteTable('runbook_run', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runbookId: integer('runbook_id'),
  name: text('name').notNull(),
  params: text('params').notNull(),
  // JSON: the resolved steps with their progress
  steps: text('steps').notNull(),
  // index of the step that runs now (or next)
  cursor: integer('cursor').notNull().default(0),
  // pending (waits for approval), running, done, stopped, failed, rejected
  status: text('status').notNull(),
  // bumped on every update, so two server instances never take the same step
  version: integer('version').notNull().default(0),
  startedBy: text('started_by').notNull(),
  startedById: text('started_by_id').notNull(),
  decidedBy: text('decided_by'),
  startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
  finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
  error: text('error'),
})

/** A webhook that starts a runbook: other tools call it with a secret instead of signing in. */
export const runbookHook = sqliteTable('runbook_hook', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  runbookId: integer('runbook_id').notNull(),
  // checks the caller: the HMAC signature's key, or the bearer token itself
  secret: text('secret').notNull(),
  // JSON: values set here, and the names of the values a call may set
  params: text('params').notNull(),
  fromRequest: text('from_request').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdBy: text('created_by'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  lastCalledAt: integer('last_called_at', { mode: 'timestamp_ms' }),
  lastRunId: integer('last_run_id'),
  lastError: text('last_error'),
})
