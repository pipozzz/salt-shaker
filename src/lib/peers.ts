import { demoPeers } from '../api/demo-peers'
import { peers } from '../api/server'
import { useSession } from './session'

/** The other instances: the server's, the demo's made-up ones, or none (live mode talks to one master). */
export function usePeersApi() {
  const { session } = useSession()
  return session?.mode === 'demo' ? demoPeers : session?.mode === 'server' ? peers : null
}
