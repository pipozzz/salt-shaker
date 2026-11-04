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
})

/** Where alerts go: a Slack-compatible incoming webhook or a generic JSON webhook. */
export const notificationChannel = sqliteTable('notification_channel', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  kind: text('kind').notNull(),
  url: text('url').notNull(),
  events: text('events').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
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
