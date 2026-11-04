import { afterEach, describe, expect, it } from 'vitest'
import type { Config } from './config'
import { Leader } from './leader'
import { systemStatus, type SystemDeps } from './system'
import { openTestDatabase, testDialects } from './testdb'

const config = {
  publicUrl: 'https://salt.example.com',
  trustedOrigins: [],
  dialect: 'sqlite',
  saltApi: { url: 'https://master:8000', username: 'salt-shaker', password: 'top-secret', eauth: 'sharedsecret' },
  historyDays: 90,
  presenceMinutes: 5,
  trustProxy: false,
  passwordLogin: 'admins',
  oidc: { name: 'Keycloak' },
  metricsToken: 'also-secret',
} as unknown as Config

const keys = { data: { return: { minions: ['a', 'b'], minions_pre: ['c'], minions_rejected: [], minions_denied: [] } } }

describe.each(testDialects)('systemStatus (%s)', (dialect) => {
  let close: (() => Promise<unknown>) | null = null
  afterEach(async () => {
    await close?.()
    close = null
  })

  async function setup(salt: SystemDeps['salt']) {
    const opened = await openTestDatabase(dialect)
    close = opened.close
    const { db, schema } = opened
    const leader = new Leader(db, schema, 'events', { onAcquire: () => undefined, onLose: () => undefined }, 30_000, 'me')
    const deps: SystemDeps = {
      db,
      schema,
      salt,
      config,
      version: '9.9.9',
      instance: 'me',
      startedAt: new Date(0),
      leader,
      stream: { state: 'connected', since: new Date(1), lastEventAt: new Date(2), lastError: null },
      ssoActive: false,
    }
    return { db, schema, leader, deps }
  }

  it('reports salt-api, the event bus, the database and settings, without secrets', async () => {
    const { db, schema, leader, deps } = await setup({ call: async () => keys })
    await db.insert(schema.job).values([
      { jid: '1', fun: 'test.ping', startedAt: new Date(Date.UTC(2026, 10, 1)) },
      { jid: '2', fun: 'test.ping', startedAt: new Date(Date.UTC(2026, 10, 2)) },
    ])
    await db.insert(schema.notificationChannel).values([
      { name: 'ops', kind: 'slack', url: 'https://hooks.example.com/x', events: '[]', createdAt: new Date() },
      { name: 'pager', kind: 'webhook', url: 'https://pager.example.com', events: '[]', enabled: false, lastError: 'HTTP 500', createdAt: new Date() },
    ])

    // nobody holds the lease yet: no stream to report
    let s = await systemStatus(deps)
    expect(s.events).toEqual({ leader: null, leaderStale: null, thisInstance: false, stream: null })

    expect(await leader.tryAcquire()).toBe(true)
    // tryAcquire alone doesn't flip isLeader (tick does); report as the leader would
    s = await systemStatus({ ...deps, leader: { isLeader: true, holderNow: () => leader.holderNow() } })
    expect(s.events.leader).toBe('me')
    expect(s.events.stream?.state).toBe('connected')
    expect(s.saltApi).toMatchObject({ url: 'https://master:8000', username: 'salt-shaker', eauth: 'sharedsecret', ok: true, error: null, keys: { accepted: 2, pending: 1, rejected: 0, denied: 0 } })
    expect(s.database).toEqual({ dialect: 'sqlite', jobs: 2, oldestJob: new Date(Date.UTC(2026, 10, 1)), retentionDays: 90 })
    expect(s.notifications).toEqual({ channels: 2, enabled: 1, failing: [{ name: 'pager', error: 'HTTP 500' }] })
    expect(s.schedules).toEqual({ total: 0, enabled: 0 })
    expect(s.settings).toEqual({ publicUrl: 'https://salt.example.com', trustedOrigins: [], sso: { name: 'Keycloak', active: false }, passwordLogin: 'admins', presenceMinutes: 5, metrics: true, trustProxy: false })
    const json = JSON.stringify(s)
    expect(json).not.toContain('top-secret')
    expect(json).not.toContain('also-secret')
  })

  it('says why salt-api fails', async () => {
    const { deps } = await setup({
      call: async () => {
        throw new Error('Cannot reach salt-api at https://master:8000: the connection was refused')
      },
    })
    const s = await systemStatus(deps)
    expect(s.saltApi).toMatchObject({ ok: false, keys: null, error: 'Cannot reach salt-api at https://master:8000: the connection was refused' })
  })

  it('tells a holder that stopped renewing from a live one, and an expired lease from both', async () => {
    const { leader } = await setup({ call: async () => keys })
    expect(await leader.tryAcquire(new Date(0))).toBe(true)
    // renewed every 10 s with a 30 s lease: fine for 15 s, then stale until it expires
    expect(await leader.holderNow(new Date(10_000))).toMatchObject({ holder: 'me', stale: false, renewedAt: new Date(0), expiresAt: new Date(30_000) })
    expect(await leader.holderNow(new Date(20_000))).toMatchObject({ holder: 'me', stale: true })
    expect(await leader.holderNow(new Date(30_000))).toBeNull()
  })
})
