import { demoVulns } from '../api/demo-vulns'
import { vulns as serverVulns } from '../api/server'
import { useSession } from './session'

/** The server's vulnerability report, or the demo's made-up one. */
export function useVulnApi() {
  const { session } = useSession()
  return session?.mode === 'demo' ? demoVulns : serverVulns
}
