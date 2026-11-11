import { demoChanges } from '../api/demo-changes'
import { changes, type ChangeStatus } from '../api/server'
import type { Tone } from '../components/ui'
import { isRisky } from './risk'
import { useSession } from './session'

/** The server's changes, or the demo's; none without a server. */
export function useChangesApi() {
  const { session } = useSession()
  return session?.mode === 'demo' ? demoChanges : session?.mode === 'server' ? changes : null
}

/** Whether running this needs an admin's approval first (APPROVAL_REQUIRED=risky, for non-admins). */
export function useNeedsApproval() {
  const { session, server } = useSession()
  return (fun: string, args: string) => session?.mode === 'server' && server?.approval === 'risky' && session.eauth !== 'admin' && isRisky(fun, args)
}

export const CHANGE_STATUS: Record<ChangeStatus, { tone: Tone; label: string }> = {
  pending: { tone: 'amber', label: 'waiting for approval' },
  rejected: { tone: 'zinc', label: 'rejected' },
  queued: { tone: 'blue', label: 'starting' },
  running: { tone: 'blue', label: 'running' },
  done: { tone: 'green', label: 'done' },
  stopped: { tone: 'red', label: 'stopped' },
  failed: { tone: 'red', label: 'failed' },
}

export const changeTarget = (c: { target: string; targetType: string }) => `${c.targetType === 'glob' ? '' : `${c.targetType}:`}${c.target}`
