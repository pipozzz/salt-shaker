import { trimFleet } from '../lib/fleet'
import { gitConfigUrl, gitPillarRemotes as parseGitPillar, headBranch, matchRemote, parseRemoteMap, treeFiles, type GitPillarRemote, type GitPillarRepo } from '../lib/gitpillar'
import { parseSaltStamp } from '../lib/stamp'
export { parseArgs } from '../lib/args'
import {
  SaltError,
  type ActiveJob,
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
      const utc = parseSaltStamp(res.data._stamp)
      if (local && utc) this.masterOffsetMs = Math.round((local.getTime() - utc.getTime()) / 60_000) * 60_000
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
  /** Who answers. With the server it's what it last recorded, unless `fresh` asks the master now. */
  async status(fresh = false) {
    if (this.transport.status) {
      try {
        return await this.transport.status(fresh)
      } catch (e) {
        if (e instanceof SaltError && e.status === 401) this.onAuthError()
        throw e
      }
    }
    // as kwarg: a top-level `timeout` is salt-api's own limit for the runner, which then answers
    // 504 whenever a minion is down instead of waiting for manage.status to give up on it
    return this.runner<{ up: string[]; down: string[] }>('manage.status', { kwarg: { timeout: 3, gather_job_timeout: 3 } })
  }
  grains(tgt = '*', tgt_type: TargetType = 'glob') {
    return this.local<Grains>(tgt, 'grains.items', [], {}, tgt_type)
  }
  /** Which minions a target matches, from the master's cache — nothing runs on minions. */
  async matchTarget(tgt: string, tgt_type: TargetType) {
    const res = await this.runner<Record<string, unknown> | string>('cache.grains', { tgt, tgt_type })
    return typeof res === 'object' && res ? Object.keys(res).sort() : []
  }
  /** The master's own Salt version (null if the account may not run salt.cmd). */
  async masterVersion() {
    try {
      const v = await this.runner<unknown>('salt.cmd', { arg: ['test.version'] })
      return typeof v === 'string' ? v : null
    } catch {
      return null
    }
  }
  /**
   * Fleet-wide grains for overviews, from the master's minion data cache: no job on the minions,
   * and offline minions keep their last known grains. Falls back to live grains.items when the
   * cache is empty (minion_data_cache off) or the account may not read it.
   */
  async fleet(fresh = false): Promise<Record<string, Grains>> {
    if (this.transport.fleet) {
      try {
        return await this.transport.fleet(fresh)
      } catch (e) {
        if (e instanceof SaltError && e.status === 401) this.onAuthError()
        throw e
      }
    }
    try {
      const cached = trimFleet(await this.runner<Record<string, unknown>>('cache.grains', { tgt: '*', tgt_type: 'glob' }))
      if (Object.keys(cached).length) return cached
    } catch (e) {
      if (e instanceof SaltError && e.status === 401) throw e
    }
    return trimFleet(await this.grains())
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
  /** Jobs that minions are still running. Asks every minion, so it takes a few seconds. */
  async activeJobs() {
    await this.learnOffset()
    return this.runner<Record<string, ActiveJob>>('jobs.active')
  }
  /** Which of the given minions are still running a job (saltutil.find_job; offline ones don't answer). */
  async stillRunning(jid: string, minions: string[]) {
    if (!minions.length) return []
    const res = await this.local<Record<string, unknown>>(minions.join(','), 'saltutil.find_job', [jid], {}, 'list')
    return Object.entries(res ?? {})
      .filter(([, r]) => !!r && typeof r === 'object' && (r as { jid?: unknown }).jid === jid)
      .map(([id]) => id)
      .sort()
  }
  /** Kills a job's process on the given minions; they never return for it. */
  killJob(jid: string, minions: string[]) {
    return this.local<string>(minions.join(','), 'saltutil.kill_job', [jid], {}, 'list')
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

  /** Every file the fileserver serves in a saltenv, from file_roots, gitfs and any other backend, as minions see them. */
  async served(saltenv = 'base') {
    const res = await this.runner<string[]>('fileserver.file_list', { saltenv })
    return Array.isArray(res) ? res : []
  }
  /** A file as minions get it from the fileserver (cp.get_file_str on the master), whatever backend serves it. */
  async readServed(path: string, saltenv = 'base') {
    const res = await this.runner<string | false>('salt.cmd', { arg: ['cp.get_file_str', `salt://${path}`], kwarg: { saltenv } })
    if (typeof res !== 'string') throw new SaltError(`salt://${path} isn't served in ${saltenv}`)
    return res
  }
  /** The fileserver's environments: base, and with gitfs every branch and tag. */
  async saltenvs() {
    const res = await this.runner<string[]>('fileserver.envs')
    return Array.isArray(res) && res.length ? res : ['base']
  }
  /** Fetches gitfs and other remote backends now instead of at the next update interval. */
  updateFileserver() {
    return this.runner<boolean>('fileserver.update')
  }

  // ---- git_pillar ----
  /** An execution module function run on the master itself, with the master's config. */
  private onMaster<T>(fun: string, arg: unknown[] = [], kwarg: Record<string, unknown> = {}) {
    return this.runner<T>('salt.cmd', { arg: [fun, ...arg], kwarg })
  }
  /** git_pillar remotes in the master's ext_pillar; empty when pillar doesn't come from git. */
  async gitPillarRemotes() {
    return parseGitPillar(await this.onMaster<unknown>('config.get', ['ext_pillar']))
  }
  /** The working trees git_pillar checked out on the master, matched to their remotes. */
  async gitPillarRepos(remotes: GitPillarRemote[]): Promise<GitPillarRepo[]> {
    const cachedir = await this.onMaster<string>('config.get', ['cachedir'])
    const base = `${String(cachedir || '/var/cache/salt/master').replace(/\/+$/, '')}/git_pillar`
    const [gitDirs, mapText] = await Promise.all([
      this.onMaster<string[] | string>('file.find', [base], { type: 'd', name: '.git', maxdepth: 3 }),
      this.onMaster<string | false>('file.read', [`${base}/remote_map.txt`]).catch(() => ''),
    ])
    const remoteMap = parseRemoteMap(typeof mapText === 'string' ? mapText : '')
    const repos = await Promise.all(
      (Array.isArray(gitDirs) ? gitDirs : []).map(async (g) => {
        const dir = g.replace(/\/\.git$/, '')
        const [config, head] = await Promise.all([
          this.onMaster<string>('file.read', [`${g}/config`]).catch(() => ''),
          this.onMaster<string>('file.read', [`${g}/HEAD`]).catch(() => ''),
        ])
        const m = matchRemote(remotes, { rel: dir.slice(base.length + 1), url: gitConfigUrl(String(config)), head: headBranch(String(head)) }, remoteMap)
        return m && { remote: m.remote, branch: m.branch, dir }
      }),
    )
    return repos.filter((r): r is GitPillarRepo => !!r).sort((a, b) => remotes.indexOf(a.remote) - remotes.indexOf(b.remote) || a.branch.localeCompare(b.branch))
  }
  /** Files of a checked out git_pillar repo, relative to its root parameter. */
  async gitPillarFiles(repo: GitPillarRepo) {
    const res = await this.onMaster<string[] | string>('file.find', [repo.dir], { type: 'f' })
    return treeFiles(Array.isArray(res) ? res : [], repo.dir, repo.remote.root)
  }
  async readGitPillar(repo: GitPillarRepo, path: string) {
    const full = `${repo.dir}/${repo.remote.root ? `${repo.remote.root}/` : ''}${path}`
    const res = await this.onMaster<string | false>('file.read', [full])
    if (typeof res !== 'string') throw new SaltError(`Can't read ${full} on the master`)
    return res
  }
  /** Fetches the git_pillar remotes now. */
  updateGitPillar() {
    return this.runner<unknown>('git_pillar.update')
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

/** Compares Salt versions like "3007.1", "3006.9" or "3007.17rc1" numerically: <0, 0, >0. */
export function compareVersions(a: string, b: string) {
  const pa = a.split(/[^\d]+/).filter(Boolean).map(Number)
  const pb = b.split(/[^\d]+/).filter(Boolean).map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}
