import clsx from 'clsx'
import { KeyRound, X, XCircle } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useSession } from '../lib/session'

interface Toast {
  key: string
  tone: 'error' | 'info'
  title: string
  body?: string
  link?: { to: string; label: string }
}

const Ctx = createContext<(t: Toast) => void>(() => undefined)
const TTL_MS = 10_000

/** Pushing a toast with an existing key updates it in place and restarts its timer. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const dismiss = useCallback((key: string) => {
    clearTimeout(timers.current.get(key))
    timers.current.delete(key)
    setToasts((ts) => ts.filter((t) => t.key !== key))
  }, [])

  const push = useCallback(
    (t: Toast) => {
      setToasts((ts) => (ts.some((x) => x.key === t.key) ? ts.map((x) => (x.key === t.key ? t : x)) : [...ts, t].slice(-4)))
      clearTimeout(timers.current.get(t.key))
      timers.current.set(t.key, setTimeout(() => dismiss(t.key), TTL_MS))
    },
    [dismiss],
  )

  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-50 print:hidden flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.key}
            role="status"
            className="pointer-events-auto flex gap-3 rounded-xl border border-zinc-200 bg-white p-3 shadow-lg dark:border-zinc-800 dark:bg-zinc-900"
          >
            {t.tone === 'error' ? <XCircle className="mt-0.5 size-4 shrink-0 text-red-500" /> : <KeyRound className="mt-0.5 size-4 shrink-0 text-amber-500" />}
            <div className="min-w-0 flex-1 text-sm">
              <p className="font-medium">{t.title}</p>
              {t.body && <p className="mt-0.5 truncate font-mono text-xs text-zinc-500 dark:text-zinc-400">{t.body}</p>}
              {t.link && (
                <Link to={t.link.to} onClick={() => dismiss(t.key)} className={clsx('mt-1 inline-block text-xs font-medium hover:underline', t.tone === 'error' ? 'text-red-600 dark:text-red-400' : 'text-accent-700 dark:text-accent-400')}>
                  {t.link.label} →
                </Link>
              )}
            </div>
            <button onClick={() => dismiss(t.key)} className="self-start rounded p-0.5 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 dark:text-zinc-400" aria-label="Dismiss">
              <X className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  )
}

export const useToast = () => useContext(Ctx)

// polling helpers the UI runs itself; their failures are not news
const QUIET_FUNS = new Set(['saltutil.find_job', 'sys.list_functions', 'grains.items'])

/** Turns master events into toasts: failed job returns and minions waiting for approval. */
export function EventNotifications() {
  const { subscribe } = useSession()
  const push = useToast()
  const failures = useRef(new Map<string, { fun: string; minions: string[] }>())
  const pending = useRef(new Set<string>())

  useEffect(
    () =>
      subscribe((e) => {
        const ret = e.tag.match(/^salt\/job\/(\d+)\/ret\/(.+)$/)
        if (ret) {
          const [, jid, id] = ret
          const { fun, retcode, success } = e.data as { fun?: string; retcode?: number; success?: boolean }
          if (!fun || QUIET_FUNS.has(fun)) return
          if (success !== false && (typeof retcode !== 'number' || retcode === 0)) return
          const f = failures.current.get(jid) ?? { fun, minions: [] }
          if (!f.minions.includes(id)) f.minions.push(id)
          failures.current.set(jid, f)
          const shown = f.minions.slice(0, 3).join(', ') + (f.minions.length > 3 ? ` +${f.minions.length - 3}` : '')
          push({ key: `job:${jid}`, tone: 'error', title: `${fun} failed on ${f.minions.length} ${f.minions.length === 1 ? 'minion' : 'minions'}`, body: shown, link: { to: `/jobs/${jid}`, label: 'Open job' } })
          return
        }
        if (e.tag === 'salt/auth' && e.data.act === 'pend') {
          const id = String(e.data.id)
          if (pending.current.has(id)) return
          pending.current.add(id)
          push({ key: `auth:${id}`, tone: 'info', title: 'New minion wants to join', body: id, link: { to: '/keys', label: 'Review key' } })
        }
      }),
    [subscribe, push],
  )
  return null
}
