import { demoMaintenance } from '../api/demo-windows'
import { maintenance } from '../api/server'
import { useSession } from './session'

/** Maintenance windows: the server's, the demo's, or none (live mode keeps nothing). */
export function useMaintenanceApi() {
  const { session } = useSession()
  return session?.mode === 'demo' ? demoMaintenance : session?.mode === 'server' ? maintenance : null
}
