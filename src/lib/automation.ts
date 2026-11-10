import { demoAutomation } from '../api/demo-automation'
import { automation } from '../api/server'
import { useSession } from './session'

/** Schedules and notification channels: the server's, or the demo's in-memory ones. */
export function useAutomationApi() {
  const { session } = useSession()
  return session?.mode === 'demo' ? demoAutomation : automation
}

/** Who can manage schedules: admins with the server, and everyone in the demo. */
export function useCanSchedule() {
  const { session } = useSession()
  return session?.mode === 'demo' || (session?.mode === 'server' && session.eauth === 'admin')
}
