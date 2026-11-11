import { createHmac, timingSafeEqual } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Db, Schema } from './db'
import type { AuditRow, Env, SessionUser } from './types'

/*
 * ChatOps: a /salt slash command in Slack. Slack signs each request with the app's signing secret;
 * a Slack user acts as the Salt Shaker user they linked (once, in the browser, signed in), with
 * that user's role, scope and approvals, and every command is audited under their name. Slack wants
 * an answer within 3 seconds, so anything that asks the master answers later through response_url.
 */

const MAX_SKEW_S = 5 * 60
const LINK_TTL_MS = 15 * 60_000

/** Checks X-Slack-Signature: v0=HMAC-SHA256(secret, "v0:<timestamp>:<body>"), and that the request is recent. */
export function verifySlack(secret: string, timestamp: string | undefined, body: string, signature: string | undefined, now = Date.now()) {
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false
  if (Math.abs(now / 1000 - Number(timestamp)) > MAX_SKEW_S) return false
  const want = Buffer.from(`v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`)
  const given = Buffer.from(signature)
  return given.length === want.length && timingSafeEqual(given, want)
}

interface LinkClaim {
  team: string
  user: string
  name: string
  exp: number
}

const sign = (secret: string, payload: string) => createHmac('sha256', `link:${secret}`).update(payload).digest('base64url')

/** A short-lived code that proves a Slack user asked to link: opened in the browser by the signed-in user. */
export function linkCode(secret: string, who: { team: string; user: string; name: string }, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ ...who, exp: now + LINK_TTL_MS } satisfies LinkClaim)).toString('base64url')
  return `${payload}.${sign(secret, payload)}`
}

export function readLinkCode(secret: string, code: string, now = Date.now()): LinkClaim | null {
  const [payload, mac] = code.split('.')
  if (!payload || !mac) return null
  const want = Buffer.from(sign(secret, payload))
  const given = Buffer.from(mac)
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null
  try {
    const claim = JSON.parse(Buffer.from(payload, 'base64url').toString()) as LinkClaim
    return typeof claim.team === 'string' && typeof claim.user === 'string' && claim.exp > now ? claim : null
  } catch {
    return null
  }
}

/** Splits like a shell, without one: words, and "quoted" or 'quoted' strings that keep their spaces. */
export function words(text: string) {
  const out: string[] = []
  let cur: string | null = null
  let quote: string | null = null
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      cur ??= ''
    } else if (/\s/.test(ch)) {
      if (cur !== null) out.push(cur)
      cur = null
    } else cur = (cur ?? '') + ch
  }
  if (cur !== null) out.push(cur)
  return out
}

/** glob for one pattern, list for a,b,c, compound for G@… and anything with "and"/"or". */
export function targetType(tgt: string): 'glob' | 'list' | 'compound' {
  if (/[A-Z]@|\s(and|or|not)\s/.test(tgt)) return 'compound'
  if (tgt.includes(',')) return 'list'
  return 'glob'
}

export type Command =
  | { cmd: 'help' | 'link' | 'unlink' | 'whoami' | 'status' }
  | { cmd: 'run'; tgt: string; fun: string; arg: string[]; kwarg: Record<string, string> }
  | { cmd: 'error'; error: string }

export function parseCommand(text: string): Command {
  const w = words(text.trim())
  const head = (w[0] ?? 'help').toLowerCase()
  if (['help', 'link', 'unlink', 'whoami', 'status'].includes(head)) return { cmd: head as 'help' }
  if (head === 'run') {
    const [, tgt, fun, ...rest] = w
    if (!tgt || !fun) return { cmd: 'error', error: 'Usage: /salt run <target> <function> [args] [key=value]' }
    const arg: string[] = []
    const kwarg: Record<string, string> = {}
    for (const a of rest) {
      const kv = /^([A-Za-z_]\w*)=(.*)$/.exec(a)
      if (kv) kwarg[kv[1]] = kv[2]
      else arg.push(a)
    }
    return { cmd: 'run', tgt, fun, arg, kwarg }
  }
  if (head === 'highstate') {
    const [, tgt, mode] = w
    if (!tgt) return { cmd: 'error', error: 'Usage: /salt highstate <target> [test]' }
    return { cmd: 'run', tgt, fun: 'state.apply', arg: [], kwarg: mode === 'test' ? { test: 'True' } : {} }
  }
  return { cmd: 'error', error: `Unknown command "${head}". Try /salt help.` }
}

const HELP = [
  '*/salt* runs Salt from Slack as your Salt Shaker user, with your role and limits; everything is in the audit log.',
  '• `/salt link`: link your Slack account to your Salt Shaker user (once)',
  '• `/salt status`: which minions answer',
  '• `/salt highstate <target> [test]`: apply the highstate, or dry-run it with `test`',
  '• `/salt run <target> <function> [args] [key=value]`: e.g. `/salt run web-* service.restart nginx`',
  '• `/salt whoami`, `/salt unlink`',
  'Targets: `web-*`, `web-01,web-02`, or compound like `G@os:Debian and web-*`.',
].join('\n')

type Reply = { response_type: 'ephemeral' | 'in_channel'; text: string }
const ephemeral = (text: string): Reply => ({ response_type: 'ephemeral', text })

export interface SaltAs {
  (user: SessionUser, input: unknown, ip: string | null): Promise<{ status: number; body: { return?: unknown; error?: string; needsApproval?: boolean } }>
}

interface Deps {
  db: Db
  schema: Schema
  secret: string | null
  publicUrl: string
  saltAs: SaltAs
  audit: (row: AuditRow) => Promise<unknown>
  /** POSTs a message to Slack's response_url */
  post?: (url: string, body: Reply) => Promise<unknown>
  sleep?: (ms: number) => Promise<unknown>
  /** how long to wait for a job's returns before posting its outcome */
  waitMs?: number
  now?: () => number
}

const defaultPost = async (url: string, body: Reply) => {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`Slack answered ${res.status}`)
}

/** Only Slack's own response URLs: the address comes in the request, so it mustn't point anywhere else. */
export const isSlackResponseUrl = (url: string) => /^https:\/\/hooks\.slack\.com\/commands\//.test(url)

export function slackRoutes(d: Deps) {
  const r = new Hono<Env>()
  const post = d.post ?? defaultPost
  const sleep = d.sleep ?? ((ms: number) => new Promise((res) => setTimeout(res, ms)))
  const now = d.now ?? Date.now
  const { db, schema } = d
  const t = schema.slackLink
  const link = (path: string) => `${d.publicUrl}${path}`

  async function linkedUser(team: string, slackUser: string): Promise<SessionUser | null> {
    const [row] = await db.select().from(t).where(and(eq(t.team, team), eq(t.slackUser, slackUser))).limit(1)
    if (!row) return null
    const u = schema.user
    const [user] = await db.select({ id: u.id, name: u.name, username: u.username, role: u.role, banned: u.banned }).from(u).where(eq(u.id, row.userId)).limit(1)
    if (!user || user.banned || !user.role || user.role === 'none') return null
    return { id: user.id, name: user.name, username: user.username, role: user.role }
  }

  /** Waits for a job's returns (the history keeps them) and sums them up. */
  async function outcome(jid: string, minions: string[]) {
    const jr = schema.jobReturn
    const deadline = now() + (d.waitMs ?? 120_000)
    let rows: Array<{ minion: string; retcode: number | null; success: boolean | null }> = []
    while (true) {
      rows = await db.select({ minion: jr.minion, retcode: jr.retcode, success: jr.success }).from(jr).where(eq(jr.jid, jid))
      if (rows.length >= minions.length || now() >= deadline) break
      await sleep(5000)
    }
    const failed = rows.filter((x) => (x.retcode ?? 0) !== 0 || x.success === false).map((x) => x.minion).sort()
    const returned = new Set(rows.map((x) => x.minion))
    return { ok: rows.length - failed.length, failed, missing: minions.filter((m) => !returned.has(m)).sort() }
  }

  async function run(user: SessionUser, c: Extract<Command, { cmd: 'run' }>, responseUrl: string) {
    const name = user.username ?? user.name
    const tgtType = targetType(c.tgt)
    const kwarg = Object.fromEntries(Object.entries(c.kwarg).map(([k, v]) => [k, v === 'True' ? true : v === 'False' ? false : v]))
    const res = await d.saltAs(user, { client: 'local_async', tgt: c.tgt, tgt_type: tgtType, fun: c.fun, arg: c.arg, kwarg }, null)
    if (res.status !== 200) {
      const why = res.body.needsApproval ? `${res.body.error}: <${link('/run')}|open Run in Salt Shaker> and roll it out as a change.` : (res.body.error ?? 'It failed')
      return post(responseUrl, ephemeral(`:no_entry: ${why}`))
    }
    // salt.call hands back the first return: {jid, minions} for local_async
    const started = res.body.return as { jid?: string; minions?: string[] } | null
    if (!started?.jid) return post(responseUrl, ephemeral(`:warning: No minion matched \`${c.tgt}\`.`))
    const minions = started.minions ?? []
    const what = `\`${[c.fun, ...c.arg, ...Object.entries(c.kwarg).map(([k, v]) => `${k}=${v}`)].join(' ')}\``
    await post(responseUrl, { response_type: 'in_channel', text: `*${name}* ran ${what} on \`${c.tgt}\` (${minions.length} ${minions.length === 1 ? 'minion' : 'minions'}): <${link(`/jobs/${started.jid}`)}|job ${started.jid}>` })
    const o = await outcome(started.jid, minions)
    const parts = [`${o.ok} succeeded`, ...(o.failed.length ? [`${o.failed.length} failed (${o.failed.slice(0, 10).join(', ')}${o.failed.length > 10 ? ', …' : ''})`] : []), ...(o.missing.length ? [`${o.missing.length} didn't return yet`] : [])]
    await post(responseUrl, { response_type: 'in_channel', text: `${o.failed.length ? ':x:' : o.missing.length ? ':hourglass:' : ':white_check_mark:'} ${what} on \`${c.tgt}\`: ${parts.join(', ')}` })
  }

  async function status(user: SessionUser, responseUrl: string) {
    const res = await d.saltAs(user, { client: 'runner', fun: 'manage.status', kwarg: { timeout: 3, gather_job_timeout: 3 } }, null)
    if (res.status !== 200) return post(responseUrl, ephemeral(`:no_entry: ${res.body.error ?? 'It failed'}`))
    const s = (res.body.return ?? {}) as { up?: string[]; down?: string[] }
    const down = s.down ?? []
    await post(responseUrl, ephemeral(`${down.length ? ':warning:' : ':white_check_mark:'} ${(s.up ?? []).length} minions answer${down.length ? `, ${down.length} don't: ${down.slice(0, 20).join(', ')}` : ''}. <${link('/minions')}|Minions>`))
  }

  r.post('/slack/commands', async (c) => {
    if (!d.secret) return c.json({ error: 'Slack is not set up (SLACK_SIGNING_SECRET)' }, 404)
    const body = await c.req.text()
    if (!verifySlack(d.secret, c.req.header('x-slack-request-timestamp'), body, c.req.header('x-slack-signature'), now())) return c.json({ error: 'Bad signature' }, 401)
    const f = new URLSearchParams(body)
    const team = f.get('team_id') ?? ''
    const slackUser = f.get('user_id') ?? ''
    const slackName = f.get('user_name') ?? slackUser
    const responseUrl = f.get('response_url') ?? ''
    const command = parseCommand(f.get('text') ?? '')

    if (command.cmd === 'help') return c.json(ephemeral(HELP))
    if (command.cmd === 'error') return c.json(ephemeral(command.error))
    if (command.cmd === 'link') {
      const code = linkCode(d.secret, { team, user: slackUser, name: slackName }, now())
      return c.json(ephemeral(`<${link(`/slack/link?code=${encodeURIComponent(code)}`)}|Link your Slack account> to your Salt Shaker user: open it while signed in, within 15 minutes. Only you can see this.`))
    }
    if (command.cmd === 'unlink') {
      await db.delete(t).where(and(eq(t.team, team), eq(t.slackUser, slackUser)))
      return c.json(ephemeral('Unlinked. `/salt link` links again.'))
    }
    const user = await linkedUser(team, slackUser)
    if (!user) return c.json(ephemeral('Your Slack account isn’t linked to a Salt Shaker user (or that user can’t sign in any more). Run `/salt link` first.'))
    if (command.cmd === 'whoami') return c.json(ephemeral(`You act as *${user.username ?? user.name}* (${user.role}) in Salt Shaker.`))
    if (!isSlackResponseUrl(responseUrl)) return c.json(ephemeral('Slack sent no response URL'), 400)
    const later = (work: Promise<unknown>) => void work.catch((e) => console.warn('slack: command failed', e))
    if (command.cmd === 'run') {
      later(run(user, command, responseUrl))
      return c.json(ephemeral(`Starting \`${command.fun}\` on \`${command.tgt}\`…`))
    }
    later(status(user, responseUrl))
    return c.json(ephemeral('Asking the master…'))
  })

  // linking, in the browser: the signed-in user claims the Slack account the code was made for
  for (const path of ['/slack/link', '/slack/links']) {
    r.use(path, async (c, next) => {
      const user = c.get('user')
      if (!user) return c.json({ error: 'Not signed in' }, 401)
      if (c.get('via') === 'token') return c.json({ error: 'Link Slack from the web UI' }, 403)
      await next()
    })
  }
  r.get('/slack/links', async (c) => {
    const rows = await db.select().from(t).where(eq(t.userId, c.get('user')!.id))
    return c.json({ enabled: !!d.secret, links: rows.map((x) => ({ team: x.team, slackUser: x.slackUser, slackName: x.slackName, linkedAt: x.linkedAt })) })
  })
  r.post('/slack/link', async (c) => {
    if (!d.secret) return c.json({ error: 'Slack is not set up' }, 404)
    const user = c.get('user')!
    const body = (await c.req.json().catch(() => ({}))) as { code?: unknown }
    const claim = typeof body.code === 'string' ? readLinkCode(d.secret, body.code, now()) : null
    if (!claim) return c.json({ error: 'This link has expired or isn’t valid: run /salt link again' }, 400)
    const values = { team: claim.team, slackUser: claim.user, userId: user.id, slackName: claim.name, linkedAt: new Date(now()) }
    await db.insert(t).values(values).onConflictDoUpdate({ target: [t.team, t.slackUser], set: { userId: user.id, slackName: claim.name, linkedAt: values.linkedAt } })
    await d.audit({ userId: user.id, username: user.username ?? user.name, role: user.role ?? null, client: 'console', fun: 'slack.link', target: `${claim.name} (${claim.team}/${claim.user})`, outcome: 'ok' })
    return c.json({ slackName: claim.name })
  })
  r.delete('/slack/links', async (c) => {
    const user = c.get('user')!
    await db.delete(t).where(eq(t.userId, user.id))
    await d.audit({ userId: user.id, username: user.username ?? user.name, role: user.role ?? null, client: 'console', fun: 'slack.unlink', outcome: 'ok' })
    return c.json({ ok: true })
  })
  return r
}
