import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { targets as api, type SharedTarget } from '../api/server'
import type { TargetType } from '../api/types'
import { useSession } from './session'
import { storage } from './storage'

const LOCAL_KEY = 'salt-shaker.targets'

export interface SavedTarget {
  name: string
  tgt: string
  tgtType: TargetType
  /** saved on the server for the whole team (otherwise only in this browser) */
  shared?: { id: number; createdBy: string | null }
}

type Local = Array<{ name: string; tgt: string; tgtType: TargetType }>

// one copy of the team's targets for every component that shows them
let shared: SharedTarget[] | null = null
let local: Local = storage.get<Local>(LOCAL_KEY) ?? []
let loading: Promise<void> | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
let snapshot: { shared: SharedTarget[] | null; local: Local } = { shared, local }
const publish = () => {
  snapshot = { shared, local }
  emit()
}

function setLocal(next: Local) {
  local = next
  storage.set(LOCAL_KEY, local)
  publish()
}

async function loadShared(force = false) {
  if (loading && !force) return loading
  loading = api
    .list()
    .then((r) => {
      shared = r.targets
      publish()
    })
    .catch(() => {
      // keep what we had; the server may be briefly away
    })
  return loading
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

/**
 * Saved targets: with the server, the team's shared list plus any still kept only in this
 * browser; without it, the browser's list.
 */
export function useSavedTargets() {
  const { session } = useSession()
  const server = session?.mode === 'server'
  const role = server ? session.eauth : null
  const me = session?.user ?? null
  const state = useSyncExternalStore(subscribe, () => snapshot)

  useEffect(() => {
    if (server) void loadShared()
  }, [server])

  const { team, browser } = useMemo(() => {
    const team: SavedTarget[] = server ? (state.shared ?? []).map((t) => ({ name: t.name, tgt: t.target, tgtType: t.targetType as TargetType, shared: { id: t.id, createdBy: t.createdBy } })) : []
    const browser: SavedTarget[] = state.local.filter((l) => !team.some((t) => t.name === l.name))
    return { team, browser }
  }, [server, state])
  const all = useMemo(() => [...team, ...browser], [team, browser])
  const canShare = server && (role === 'admin' || role === 'operator')

  const save = useCallback(
    async (name: string, tgt: string, tgtType: TargetType) => {
      if (canShare) {
        await api.save({ name, target: tgt, targetType: tgtType })
        await loadShared(true)
      } else {
        setLocal([...local.filter((s) => s.name !== name), { name, tgt, tgtType }])
      }
    },
    [canShare],
  )

  const remove = useCallback(async (t: SavedTarget) => {
    if (t.shared) {
      await api.remove(t.shared.id)
      await loadShared(true)
    } else {
      setLocal(local.filter((s) => s.name !== t.name))
    }
  }, [])

  /** Moves the targets kept in this browser to the team's list. */
  const shareLocal = useCallback(async () => {
    const moved: string[] = []
    try {
      for (const l of browser) {
        await api.save({ name: l.name, target: l.tgt, targetType: l.tgtType })
        moved.push(l.name)
      }
    } finally {
      setLocal(local.filter((s) => !moved.includes(s.name)))
      await loadShared(true)
    }
  }, [browser])

  return {
    targets: all,
    /** targets only this browser has, which could be shared */
    unshared: canShare ? browser.length : 0,
    canRemove: (t: SavedTarget) => !t.shared || role === 'admin' || t.shared.createdBy === me,
    save,
    remove,
    shareLocal,
  }
}
