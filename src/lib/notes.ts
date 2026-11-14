import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { demoMinionNotes } from '../api/demo-notes'
import { minionNotes, type MinionNote } from '../api/server'
import { useSession } from './session'

/*
 * Notes on minions, one copy for every component that shows them: the server's, the demo's, or
 * none (live mode keeps nothing).
 */

type Notes = Record<string, MinionNote>
let notes: Notes | null = null
let loadedFor: object | null = null
let loading: Promise<void> | null = null
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
const publish = (next: Notes) => {
  notes = next
  listeners.forEach((l) => l())
}

function load(api: typeof minionNotes, force = false) {
  if (loading && loadedFor === api && !force) return loading
  loadedFor = api
  loading = api
    .list()
    .then((r) => publish(r.notes))
    .catch(() => {
      // keep what we had; the server may be briefly away
    })
  return loading
}

export function useMinionNotes() {
  const { session } = useSession()
  const api = session?.mode === 'demo' ? demoMinionNotes : session?.mode === 'server' ? minionNotes : null
  const role = session?.mode === 'demo' ? 'admin' : session?.mode === 'server' ? session.eauth : null
  const current = useSyncExternalStore(subscribe, () => notes)

  useEffect(() => {
    if (api) void load(api)
  }, [api])

  const save = useCallback(
    async (minion: string, note: string) => {
      if (!api) return
      const { note: saved } = await api.save(minion, note)
      const next = { ...(notes ?? {}) }
      if (saved) next[minion] = saved
      else delete next[minion]
      publish(next)
    },
    [api],
  )

  return {
    /** null until loaded, and in live mode */
    notes: api && loadedFor === api ? current : null,
    available: !!api,
    canWrite: role === 'admin' || role === 'operator',
    save,
    reload: () => (api ? load(api, true) : Promise.resolve()),
  }
}
