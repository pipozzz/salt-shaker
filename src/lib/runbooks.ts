import { demoUsers } from '../api/demo-admin'
import { demoRunbookHooks, demoRunbooks } from '../api/demo-runbooks'
import { runbookHooks, runbooks, users } from '../api/server'
import { mayRun, type RunbookInput } from './runbook'
import { useSession } from './session'

/** Runbooks: the server's, the demo's, or none (live mode keeps nothing). */
export function useRunbooksApi() {
  const { session } = useSession()
  return session?.mode === 'demo' ? demoRunbooks : session?.mode === 'server' ? runbooks : null
}

/** Webhooks that start runbooks: the server's or the demo's (admins only). */
export function useRunbookHooksApi() {
  const { session } = useSession()
  return session?.mode === 'demo' ? demoRunbookHooks : session?.mode === 'server' ? runbookHooks : null
}

/** Where other tools send their calls. */
export const hookUrl = (id: number) => `${window.location.origin}/api/hooks/runbooks/${id}`

/** How a run's status reads, and its colour. */
export const RUN_STATUS = {
  pending: { label: 'waiting for approval', tone: 'amber' },
  running: { label: 'running', tone: 'blue' },
  done: { label: 'done', tone: 'green' },
  stopped: { label: 'stopped', tone: 'red' },
  failed: { label: 'failed', tone: 'red' },
  rejected: { label: 'rejected', tone: 'zinc' },
} as const

/** Who may do what with runbooks: admins write, operators and admins run (everyone in the demo). */
export function useRunbookRole() {
  const { session } = useSession()
  const role = session?.mode === 'demo' ? 'admin' : session?.mode === 'server' ? session.eauth : null
  const me = session?.mode === 'demo' ? 'demo' : (session?.user ?? null)
  return {
    canWrite: role === 'admin',
    canRun: role === 'admin' || role === 'operator',
    me,
    /** whether this runbook is one I may run: admins any, operators the ones that name none or them */
    mayRun: (rb: Pick<RunbookInput, 'runners'>) => mayRun(rb, { role, username: me }),
  }
}

/** Accounts to name as a runbook's runners (admins write runbooks, and only they list users). */
export function useUsersForRunbooks() {
  const { session } = useSession()
  return session?.mode === 'demo' ? demoUsers : users
}

/** "olga, bob and admins" */
export const runnersText = (runners: string[]) => (runners.length ? `${runners.join(', ')} and admins` : 'every operator')
