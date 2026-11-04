import { asc, count, eq } from 'drizzle-orm'
import type { Config } from './config'
import type { Db, Schema } from './db'
import type { StreamStatus } from './history'
import { keyCounts } from './metrics'
import type { SaltService } from './salt'

export interface SystemDeps {
  db: Db
  schema: Schema
  salt: Pick<SaltService, 'call'>
  config: Pick<Config, 'publicUrl' | 'trustedOrigins' | 'dialect' | 'saltApi' | 'historyDays' | 'auditDays' | 'presenceMinutes' | 'trustProxy' | 'passwordLogin' | 'oidc' | 'metricsToken'>
  version: string
  instance: string
  startedAt: Date
  leader: { isLeader: boolean; holderNow: () => Promise<{ holder: string; expiresAt: Date; renewedAt: Date; stale: boolean } | null> }
  stream: StreamStatus
  /** SSO is configured and its provider answered, so the sign-in button works */
  ssoActive: boolean
}

/**
 * What an admin needs to tell whether this install works: salt-api and the service account, who
 * follows the event bus and how that's going, the database, notifications and the main settings.
 * Never includes secrets.
 */
export async function systemStatus(d: SystemDeps) {
  const { db, schema, config } = d

  // one cheap wheel call proves salt-api answers and the service account may use it
  const t0 = performance.now()
  let saltApi: { ok: boolean; ms: number; error: string | null; keys: Record<string, number> | null }
  try {
    const res = await d.salt.call({ client: 'wheel', fun: 'key.list_all' })
    saltApi = { ok: true, ms: Math.round(performance.now() - t0), error: null, keys: Object.fromEntries(keyCounts(res).map((k) => [k.labels.status, k.value])) }
  } catch (e) {
    saltApi = { ok: false, ms: Math.round(performance.now() - t0), error: e instanceof Error ? e.message : String(e), keys: null }
  }

  const [jobs] = await db.select({ n: count() }).from(schema.job)
  const [oldest] = await db.select({ at: schema.job.startedAt }).from(schema.job).orderBy(asc(schema.job.startedAt)).limit(1)
  const channels = await db.select({ name: schema.notificationChannel.name, enabled: schema.notificationChannel.enabled, lastError: schema.notificationChannel.lastError }).from(schema.notificationChannel)
  const [schedules] = await db.select({ n: count() }).from(schema.schedule)
  const [enabledSchedules] = await db.select({ n: count() }).from(schema.schedule).where(eq(schema.schedule.enabled, true))
  const holder = await d.leader.holderNow()

  return {
    version: d.version,
    instance: d.instance,
    startedAt: d.startedAt,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    saltApi: { url: config.saltApi.url, username: config.saltApi.username, eauth: config.saltApi.eauth, ...saltApi },
    events: {
      leader: holder?.holder ?? null,
      // the holder stopped renewing (crashed or killed); another instance takes over at expiresAt
      leaderStale: holder ? { stale: holder.stale, renewedAt: holder.renewedAt, expiresInSeconds: Math.max(0, Math.ceil((holder.expiresAt.getTime() - Date.now()) / 1000)) } : null,
      thisInstance: d.leader.isLeader,
      // only the leader follows the stream, so only it knows how that's going
      stream: d.leader.isLeader ? d.stream : null,
    },
    database: { dialect: config.dialect, jobs: jobs?.n ?? 0, oldestJob: oldest?.at ?? null, retentionDays: config.historyDays, auditRetentionDays: config.auditDays },
    notifications: {
      channels: channels.length,
      enabled: channels.filter((c) => c.enabled).length,
      failing: channels.filter((c) => c.lastError).map((c) => ({ name: c.name, error: c.lastError! })),
    },
    schedules: { total: schedules?.n ?? 0, enabled: enabledSchedules?.n ?? 0 },
    settings: {
      publicUrl: config.publicUrl,
      trustedOrigins: config.trustedOrigins,
      sso: config.oidc ? { name: config.oidc.name, active: d.ssoActive } : null,
      passwordLogin: config.oidc ? config.passwordLogin : 'all',
      presenceMinutes: config.presenceMinutes,
      metrics: !!config.metricsToken,
      trustProxy: config.trustProxy,
    },
  }
}

export type SystemStatus = Awaited<ReturnType<typeof systemStatus>>
