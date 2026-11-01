import {
  SaltError,
  type FileTree,
  type Grains,
  type JobDetail,
  type JobSummary,
  type KeyList,
  type Lowstate,
  type RunnerReturn,
  type SaltEvent,
  type TargetType,
  type Transport,
} from './types'

export type RootsKind = 'file' | 'pillar'

/** Typed wrapper around the salt-api clients (local / runner / wheel). */
export class SaltApi {
  private transport: Transport
  private token: string
  private onAuthError: () => void
  /** Master local clock minus UTC, learned from wheel replies; jids are in master local time. */
  private masterOffsetMs = 0
  private offsetKnown = false

  constructor(transport: Transport, token: string, onAuthError: () => void) {
    this.transport = transport
    this.token = token
    this.onAuthError = onAuthError
  }

  async call<T>(low: Lowstate): Promise<T> {
    try {
      return (await this.transport.call(low, this.token)) as T
    } catch (e) {
      if (e instanceof SaltError && e.status === 401) this.onAuthError()
      throw e
    }
  }

  async wheel<T>(fun: string, kw: Record<string, unknown> = {}): Promise<T> {
    const res = await this.call<{ data: { return: T; success: boolean; jid?: string; _stamp?: string } }>({ client: 'wheel', fun, ...kw })
    if (res.data.jid && res.data._stamp) {
      const local = jidToDate(res.data.jid)
      this.offsetKnown = true
      if (local) this.masterOffsetMs = Math.round((local.getTime() - Date.parse(`${res.data._stamp}Z`)) / 60_000) * 60_000
    }
    if (res.data.success === false) {
      throw new SaltError(typeof res.data.return === 'string' ? res.data.return : `${fun} failed`)
    }
    return res.data.return
  }

  runner<T>(fun: string, kw: Record<string, unknown> = {}) {
    return this.call<T>({ client: 'runner', fun, ...kw })
  }

  local<T>(tgt: string, fun: string, arg: unknown[] = [], kwarg: Record<string, unknown> = {}, tgt_type: TargetType = 'glob') {
    return this.call<Record<string, T>>({ client: 'local', tgt, tgt_type, fun, arg, kwarg })
  }

  // ---- keys / enrollment ----
  keys() {
    return this.wheel<KeyList>('key.list_all')
  }
  async fingerprints() {
    const res = await this.wheel<Record<string, Record<string, string>>>('key.finger', { match: '*' })
    return Object.assign({}, ...Object.values(res)) as Record<string, string>
  }
  acceptKey(id: string) {
    return this.wheel('key.accept', { match: id, include_rejected: true, include_denied: true })
  }
  rejectKey(id: string) {
    return this.wheel('key.reject', { match: id, include_accepted: true, include_denied: true })
  }
  deleteKey(id: string) {
    return this.wheel('key.delete', { match: id })
  }
  /** Generates a keypair on the master and pre-accepts it, for pre-seeded enrollment. */
  async genAccept(id: string) {
    const res = await this.wheel<{ pub?: string; priv?: string }>('key.gen_accept', { id_: id })
    // Salt answers success with {} when a key for this id already exists
    if (!res.pub || !res.priv) throw new SaltError(`A key for ${id} already exists on the master`)
    return res as { pub: string; priv: string }
  }

  // ---- minions ----
  status() {
    return this.runner<{ up: string[]; down: string[] }>('manage.status', { timeout: 3 })
  }
  grains(tgt = '*', tgt_type: TargetType = 'glob') {
    return this.local<Grains>(tgt, 'grains.items', [], {}, tgt_type)
  }
  /** Which minions a target matches, from the master's cache — nothing runs on minions. */
  async matchTarget(tgt: string, tgt_type: TargetType) {
    const res = await this.runner<Record<string, unknown> | string>('cache.grains', { tgt, tgt_type })
    return typeof res === 'object' && res ? Object.keys(res).sort() : []
  }
  pillar(minion: string) {
    return this.runner<Record<string, unknown>>('pillar.show_pillar', { minion })
  }
  async functions(minion: string) {
    const res = await this.local<string[]>(minion, 'sys.list_functions', [], {}, 'list')
    const list = res[minion]
    return Array.isArray(list) ? list : []
  }

  // ---- execution / jobs ----
  async runAsync(tgt: string, tgt_type: TargetType, fun: string, arg: unknown[], kwarg: Record<string, unknown>) {
    const res = await this.call<{ jid: string; minions: string[] } | ''>({ client: 'local_async', tgt, tgt_type, fun, arg, kwarg })
    if (!res || !res.jid) throw new SaltError('No minions matched the target')
    return res
  }
  async lookupJid(jid: string) {
    const res = await this.runner<Record<string, unknown>>('jobs.lookup_jid', { jid })
    // for jobs with a custom outputter (e.g. state.*) Salt wraps returns as {outputter, data}
    if (res && 'outputter' in res && 'data' in res && typeof res.data === 'object') return res.data as Record<string, unknown>
    return res
  }
  private async learnOffset() {
    if (!this.offsetKnown) await this.keys().catch(() => undefined)
  }
  async listJobs() {
    await this.learnOffset()
    return this.runner<Record<string, JobSummary>>('jobs.list_jobs')
  }
  async job(jid: string) {
    await this.learnOffset()
    const res = await this.runner<JobDetail>('jobs.list_job', { jid })
    return { ...res, jid }
  }

  // ---- orchestration ----
  /** Starts a runner in the background; returns its jid (events arrive as salt/run/<jid>/*). */
  async runnerAsync(fun: string, arg: unknown[] = [], kwarg: Record<string, unknown> = {}) {
    const res = await this.call<{ jid: string; tag: string }>({ client: 'runner_async', fun, arg, kwarg })
    return res.jid
  }
  /** A finished runner job's return, or null while it is still running. */
  async runnerResult(jid: string): Promise<RunnerReturn | null> {
    const res = await this.runner<Record<string, unknown>>('jobs.lookup_jid', { jid })
    // runner jobs are stored under the master's own id ("<master>_master")
    const entry = Object.values(res ?? {}).find((v): v is RunnerReturn => !!v && typeof v === 'object' && 'return' in v)
    return entry ?? null
  }

  // ---- states & pillar files ----
  async roots(kind: RootsKind) {
    const res = await this.wheel<Record<string, Array<Record<string, FileTree>>>>(`${kind}_roots.list_roots`)
    return res
  }
  async readFile(kind: RootsKind, path: string, saltenv = 'base') {
    const res = await this.wheel<Array<Record<string, string>> | string>(`${kind}_roots.read`, { path, saltenv })
    if (typeof res === 'string') throw new SaltError(res)
    return Object.values(res[0] ?? {})[0] ?? ''
  }

  /** When a job started, in the browser's clock. */
  jidDate(jid: string) {
    const d = jidToDate(jid)
    return d && new Date(d.getTime() - this.masterOffsetMs)
  }

  events(onEvent: (e: SaltEvent) => void, onStatus: (connected: boolean) => void) {
    return this.transport.events(this.token, onEvent, onStatus)
  }
}

/** Splits "a b key=val 'quoted arg'" into Salt positional args and kwargs. */
export function parseArgs(input: string) {
  const tokens = input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
  const arg: unknown[] = []
  const kwarg: Record<string, unknown> = {}
  for (const raw of tokens) {
    const eq = raw.indexOf('=')
    const isKw = eq > 0 && /^[A-Za-z_][\w]*$/.test(raw.slice(0, eq))
    const value = coerce(unquote(isKw ? raw.slice(eq + 1) : raw))
    if (isKw) kwarg[raw.slice(0, eq)] = value
    else arg.push(value)
  }
  return { arg, kwarg }
}

function unquote(s: string) {
  return s.replace(/^(["'])(.*)\1$/, '$2').replace(/(["'])/g, '')
}

function coerce(s: string): unknown {
  if (s === 'True' || s === 'true') return true
  if (s === 'False' || s === 'false') return false
  if (/^-?\d+$/.test(s)) return Number(s)
  return s
}

/** Salt jids are YYYYMMDDhhmmssffffff in the master's local time; this reads them as if UTC. */
function jidToDate(jid: string) {
  const m = jid.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/)
  if (!m) return null
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]))
}

/** Renders job Arguments back to CLI form; kwargs arrive as {__kwarg__: true, ...}. */
export function formatArgs(args: unknown[]) {
  return args
    .flatMap((a) => {
      if (a && typeof a === 'object' && '__kwarg__' in a) {
        return Object.entries(a)
          .filter(([k]) => k !== '__kwarg__')
          .map(([k, v]) => `${k}=${fmtValue(v)}`)
      }
      return [fmtValue(a)]
    })
    .join(' ')
}

function fmtValue(v: unknown) {
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  if (typeof v === 'string') return /\s/.test(v) ? `'${v}'` : v
  return typeof v === 'object' ? JSON.stringify(v) : String(v)
}
