import { useCallback, useEffect, useRef, useState } from 'react'
import { storage } from './storage'

/** Runs an async loader on mount / when deps change, with manual reload. */
export function useAsync<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | undefined>()
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(true)
  const seq = useRef(0)

  const reload = useCallback(async () => {
    const id = ++seq.current
    setLoading(true)
    try {
      const value = await load()
      if (id === seq.current) {
        setData(value)
        setError(null)
      }
    } catch (e) {
      if (id === seq.current) setError(e as Error)
    } finally {
      if (id === seq.current) setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  useEffect(() => {
    void reload()
  }, [reload])

  return { data, error, loading, reload, setData }
}

export function useStoredState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => storage.get<T>(key) ?? initial)
  useEffect(() => storage.set(key, value), [key, value])
  return [value, setValue] as const
}

export function useTheme() {
  const [theme, setTheme] = useStoredState<'light' | 'dark' | 'system'>('salt-shaker.theme', 'system')
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => document.documentElement.classList.toggle('dark', theme === 'dark' || (theme === 'system' && mq.matches))
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])
  return [theme, setTheme] as const
}

/**
 * Renders long lists a page at a time. `resetKey` identifies the current filter; when it
 * changes, the list starts again from the first page (derived, no effect needed).
 */
export function usePaged<T>(items: T[], resetKey: string, size = 100) {
  const [state, setState] = useState({ key: resetKey, count: size })
  const count = state.key === resetKey ? state.count : size
  return {
    visible: items.length > count ? items.slice(0, count) : items,
    remaining: Math.max(0, items.length - count),
    total: items.length,
    showMore: () => setState({ key: resetKey, count: count + size }),
    size,
  }
}
