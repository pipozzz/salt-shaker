import type { HttpBindings } from '@hono/node-server'

export type SessionUser = { id: string; name: string; username?: string | null; role?: string | null }

export type Env = { Bindings: HttpBindings; Variables: { user: SessionUser | null; expiresAt: Date | null } }

export type AuditRow = {
  userId?: string | null
  username: string
  role?: string | null
  client: string
  fun: string
  target?: string | null
  targetType?: string | null
  args?: string | null
  jid?: string | null
  outcome: string
  error?: string | null
  ip?: string | null
}
