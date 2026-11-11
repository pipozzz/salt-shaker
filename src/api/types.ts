export type Client = 'local' | 'local_async' | 'runner' | 'runner_async' | 'wheel'

export type TargetType = 'glob' | 'list' | 'grain' | 'compound' | 'pcre' | 'pillar' | 'nodegroup'

/** One salt-api lowstate chunk. Extra keys are passed straight to the client as kwargs. */
export interface Lowstate {
  client: Client
  fun: string
  tgt?: string
  tgt_type?: TargetType
  arg?: unknown[]
  kwarg?: Record<string, unknown>
  [key: string]: unknown
}

export interface Session {
  token: string
  expire: number
  user: string
  eauth: string
  perms?: unknown[]
  /** with the server: the minions this user is limited to, if an admin limited them */
  scope?: { target: string; targetType: string } | null
}

export interface SaltEvent {
  tag: string
  data: Record<string, unknown>
}

export interface Transport {
  login(username: string, password: string, eauth: string): Promise<Session>
  logout(token: string): Promise<void>
  call(low: Lowstate, token: string): Promise<unknown>
  /** Optional shortcut for fleet grains (the server caches and trims them). */
  fleet?(fresh: boolean): Promise<Record<string, Grains>>
  /** Subscribes to the master event bus; returns an unsubscribe function. */
  events(token: string, onEvent: (e: SaltEvent) => void, onStatus: (connected: boolean) => void): () => void
}

export interface KeyList {
  minions: string[]
  minions_pre: string[]
  minions_rejected: string[]
  minions_denied: string[]
  local?: string[]
}

export type Grains = Record<string, unknown> & {
  id?: string
  os?: string
  osrelease?: string
  osfinger?: string
  kernel?: string
  kernelrelease?: string
  num_cpus?: number
  mem_total?: number
  ipv4?: string[]
  saltversion?: string
  roles?: string[]
  virtual?: string
}

export interface JobSummary {
  Function: string
  Arguments: unknown[]
  Target: string | string[]
  'Target-type': string
  User: string
  StartTime: string
}

/** A job some minions are still running (runner jobs.active); Running lists {minion: pid}. */
export interface ActiveJob extends JobSummary {
  Running: Array<Record<string, number>>
  Returned?: string[]
}

export interface JobDetail extends JobSummary {
  jid: string
  Minions?: string[]
  Result?: Record<string, { return: unknown; retcode?: number; success?: boolean }>
}

/** file_roots / pillar_roots tree: directories are nested objects, files are the string 'f'. */
export type FileTree = { [name: string]: FileTree | string }

export class SaltError extends Error {
  status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.status = status
  }
}

/** What a runner job (e.g. state.orchestrate) leaves in the job cache / on its ret event. */
export interface RunnerReturn {
  fun?: string
  return: unknown
  success?: boolean
}
