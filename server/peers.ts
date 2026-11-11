import { and, count, countDistinct, desc, eq, gte, ne, or } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Db, Schema } from './db'
import type { AuditRow, Env } from './types'

/*
 * Several masters: each has its own Salt Shaker, and they know about each other. Every instance
 * sums itself up at /api/summary (read-only, any signed-in user or token); an admin adds the other
 * instances with a token from each, and the overview shows how they're all doing, with a switcher
 * to open one. Nothing is run on another instance; it's only read.
 */

const HOUR = 3600_000

export interface Summary {
  name: string
  version: string
  url: string
  minions: { accepted: number; notAnswering: number | null }
  pendingKeys: number
  /** jobs with a failed minion in the last 24 hours */
  failedJobs: number
  vulns: { critical: number; high: number } | null
  waitingApproval: number
}

interface SummaryDeps {
  db: Db
  schema: Schema
  name: string
  version: string
  url: string
  keys: () => Promise<{ accepted: string[]; pending: number } | null>
}

/** How this instance is doing, from what it already keeps; one call to the master for the keys. */
export async function summarize(d: SummaryDeps, now = Date.now()): Promise<Summary> {
  const { db, schema } = d
  const keys = await d.keys()
  const accepted = keys?.accepted ?? []

  const seenRows = await db.select().from(schema.minionSeen)
  const seen = new Map(seenRows.map((r) => [r.minion, +new Date(r.lastSeenAt)]))
  const notAnswering = seenRows.length ? accepted.filter((id) => (seen.get(id) ?? 0) < now - HOUR).length : null

  const { job, jobReturn } = schema
  const [{ failed }] = await db
    .select({ failed: countDistinct(jobReturn.jid) })
    .from(jobReturn)
    .innerJoin(job, eq(job.jid, jobReturn.jid))
    .where(and(gte(job.startedAt, new Date(now - 24 * HOUR)), or(ne(jobReturn.retcode, 0), eq(jobReturn.success, false))))

  const [latest] = await db.select().from(schema.vulnDaily).orderBy(desc(schema.vulnDaily.day)).limit(1)
  const [{ waiting }] = await db.select({ waiting: count() }).from(schema.change).where(eq(schema.change.status, 'pending'))

  return {
    name: d.name,
    version: d.version,
    url: d.url,
    minions: { accepted: accepted.length, notAnswering },
    pendingKeys: keys?.pending ?? 0,
    failedJobs: Number(failed),
    vulns: latest ? { critical: latest.critical, high: latest.high } : null,
    waitingApproval: Number(waiting),
  }
}

/** An instance's address: http(s), no credentials, no trailing slash. */
export function peerUrl(raw: string) {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) return null
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`
}

export type PeerStatus = { id: number; name: string; url: string } & ({ summary: Summary; error?: undefined } | { summary?: undefined; error: string })

interface PeerDeps {
  db: Db
  schema: Schema
  audit: (row: AuditRow) => Promise<unknown>
  self: () => Promise<Summary>
  fetch?: typeof fetch
  now?: () => number
}

export function peerRoutes(d: PeerDeps) {
  const r = new Hono<Env>()
  const t = d.schema.peer
  const doFetch = d.fetch ?? fetch
  const now = d.now ?? Date.now
  let cache: { at: number; peers: PeerStatus[] } | null = null

  const signedIn = async (c: { get: (k: 'user') => Env['Variables']['user']; json: (b: unknown, s: 401) => Response }, next: () => Promise<void>) => {
    if (!c.get('user')) return c.json({ error: 'Not signed in' }, 401)
    await next()
  }
  r.use('/summary', signedIn)
  r.use('/peers', signedIn)
  r.use('/peers/*', signedIn)

  /** How this instance is doing: what the other instances read. */
  r.get('/summary', async (c) => c.json(await d.self()))

  /** The instances for the switcher: names and addresses, never their tokens. */
  r.get('/peers', async (c) => {
    const rows = await d.db.select({ id: t.id, name: t.name, url: t.url }).from(t).orderBy(t.name)
    return c.json({ self: { name: (await d.self()).name }, peers: rows })
  })

  async function readPeer(p: { id: number; name: string; url: string; token: string }): Promise<PeerStatus> {
    const base = { id: p.id, name: p.name, url: p.url }
    try {
      const res = await doFetch(`${p.url}/api/summary`, { headers: { Authorization: `Bearer ${p.token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(5000) })
      if (res.status === 401) return { ...base, error: 'The token was refused: make a new one there' }
      if (!res.ok) return { ...base, error: `It answered ${res.status}` }
      return { ...base, summary: (await res.json()) as Summary }
    } catch (e) {
      return { ...base, error: e instanceof Error && e.name === 'TimeoutError' ? 'No answer within 5 seconds' : `Unreachable: ${e instanceof Error ? e.message : String(e)}` }
    }
  }

  /** Every other instance's summary, read in parallel and kept for 30 seconds. */
  r.get('/peers/status', async (c) => {
    if (!cache || now() - cache.at > 30_000 || c.req.query('fresh')) {
      const rows = await d.db.select().from(t).orderBy(t.name)
      cache = { at: now(), peers: await Promise.all(rows.map(readPeer)) }
    }
    return c.json({ peers: cache.peers })
  })

  r.post('/peers', async (c) => {
    const user = c.get('user')!
    if (user.role !== 'admin') return c.json({ error: 'Admins only' }, 403)
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const url = typeof body.url === 'string' ? peerUrl(body.url) : null
    const token = typeof body.token === 'string' ? body.token.trim() : ''
    if (!name || name.length > 60) return c.json({ error: 'Give it a name (60 characters at most)' }, 400)
    if (!url) return c.json({ error: 'The address has to be an http(s) URL of a Salt Shaker, like https://salt-eu.example.com' }, 400)
    if (!token.startsWith('ss_')) return c.json({ error: 'Paste an API token made on that instance (it starts with ss_)' }, 400)
    // check it before keeping it, so a typo doesn't sit there failing
    const probe = await readPeer({ id: 0, name, url, token })
    if (probe.error) return c.json({ error: `Couldn't read ${url}: ${probe.error}` }, 400)
    const [row] = await d.db.insert(t).values({ name, url, token, createdAt: new Date(now()) }).returning({ id: t.id })
    cache = null
    await d.audit({ userId: user.id, username: user.username ?? user.name, role: user.role ?? null, client: 'admin', fun: 'peer.add', target: `${name} (${url})`, outcome: 'ok' })
    return c.json({ id: row.id, summary: probe.summary })
  })

  r.delete('/peers/:id', async (c) => {
    const user = c.get('user')!
    if (user.role !== 'admin') return c.json({ error: 'Admins only' }, 403)
    const id = Number(c.req.param('id'))
    const [row] = await d.db.select().from(t).where(eq(t.id, id))
    if (!row) return c.json({ error: 'Not found' }, 404)
    await d.db.delete(t).where(eq(t.id, id))
    cache = null
    await d.audit({ userId: user.id, username: user.username ?? user.name, role: user.role ?? null, client: 'admin', fun: 'peer.remove', target: `${row.name} (${row.url})`, outcome: 'ok' })
    return c.json({ ok: true })
  })

  return r
}
