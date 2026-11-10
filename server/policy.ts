import type { Role } from './roles'
import { canFor } from './roles'
import { READ_ONLY } from '../src/lib/readonly'

const CLIENTS = { local: 'local', local_async: 'local', runner: 'runner', runner_async: 'runner', wheel: 'wheel' } as const
type Client = keyof typeof CLIENTS

// keys salt-api would treat as per-request credentials; users must not override the service account
const AUTH_KEYS = ['username', 'password', 'eauth', 'token']


export type Decision =
  | { ok: true; low: Record<string, unknown>; client: Client; audited: boolean }
  | { ok: false; status: 400 | 403; reason: string; client?: string; fun?: string }

/** Validates a lowstate from a user, checks it against their role and prepares it for salt-api. */
export function authorize(role: Role | string | null | undefined, username: string, input: unknown): Decision {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, status: 400, reason: 'Expected one lowstate object' }
  const low = { ...(input as Record<string, unknown>) }
  const client = low.client
  const fun = low.fun
  if (typeof client !== 'string' || !(client in CLIENTS)) return { ok: false, status: 400, reason: `Unsupported client ${String(client)}` }
  if (typeof fun !== 'string' || !/^[A-Za-z_][\w.]*$/.test(fun)) return { ok: false, status: 400, reason: 'Invalid function name' }
  const kind = CLIENTS[client as Client]

  if (!canFor(role)(kind, fun)) return { ok: false, status: 403, reason: `Your role (${role ?? 'none'}) may not run ${kind} ${fun}`, client, fun }
  // salt.cmd runs any function on the master itself; the UI only needs its version
  if (kind === 'runner' && fun === 'salt.cmd' && role !== 'admin') {
    const arg = Array.isArray(low.arg) ? low.arg : []
    if (arg[0] !== 'test.version' || arg.length > 1) return { ok: false, status: 403, reason: 'salt.cmd is limited to test.version', client, fun }
  }

  for (const k of AUTH_KEYS) delete low[k]
  if (kind === 'local') {
    // shows up as Metadata in the job cache, so Salt itself records who ran it
    const meta = low.metadata && typeof low.metadata === 'object' ? (low.metadata as Record<string, unknown>) : {}
    low.metadata = { ...meta, salt_shaker_user: username }
  }
  return { ok: true, low, client: client as Client, audited: !READ_ONLY[kind].test(fun) }
}

/** The jid a call returned, if any (local_async, runner_async, wheel). */
export function jidOf(ret: unknown): string | null {
  if (!ret || typeof ret !== 'object') return null
  const r = ret as { jid?: unknown; data?: { jid?: unknown } }
  if (typeof r.jid === 'string') return r.jid
  if (typeof r.data?.jid === 'string') return r.data.jid
  return null
}
