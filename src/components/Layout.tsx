import clsx from 'clsx'
import { Activity, FolderTree, History, KeyRound, LogOut, Menu, Monitor, Moon, Server, ShieldCheck, Sun, Terminal, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useTheme } from '../lib/hooks'
import { useSalt, useSession } from '../lib/session'
import { Logo } from './Logo'
import { StatusDot } from './ui'

const nav = [
  { to: '/', label: 'Minions', icon: Server, end: true },
  { to: '/compliance', label: 'Compliance', icon: ShieldCheck },
  { to: '/keys', label: 'Enrollment', icon: KeyRound },
  { to: '/run', label: 'Run', icon: Terminal },
  { to: '/jobs', label: 'Jobs', icon: History },
  { to: '/files', label: 'States & Pillar', icon: FolderTree },
  { to: '/events', label: 'Events', icon: Activity },
]

function usePendingKeys() {
  const salt = useSalt()
  const { events } = useSession()
  const [count, setCount] = useState(0)
  const lastKeyEvent = events.find((e) => e.tag === 'salt/key' || e.tag === 'salt/auth')
  useEffect(() => {
    let alive = true
    const load = () => salt.keys().then((k) => alive && setCount(k.minions_pre.length)).catch(() => undefined)
    load()
    const t = setInterval(load, 30_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [salt, lastKeyEvent])
  return count
}

export function Layout() {
  const { session, logout, eventsConnected } = useSession()
  const [theme, setTheme] = useTheme()
  const [mobileOpen, setMobileOpen] = useState(false)
  const pending = usePendingKeys()
  const location = useLocation()
  useEffect(() => setMobileOpen(false), [location.pathname])

  const ThemeIcon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor
  const nextTheme = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system'

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center gap-2.5 px-4">
        <Logo className="size-7" />
        <span className="font-semibold tracking-tight">Salt Shaker</span>
        {session?.mode === 'demo' && (
          <span className="ml-auto rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-amber-700 uppercase dark:bg-amber-500/15 dark:text-amber-400">Demo</span>
        )}
      </div>
      <nav className="flex-1 space-y-0.5 px-2 py-2">
        {nav.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              clsx(
                'group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-white text-zinc-900 shadow-xs ring-1 ring-zinc-200 dark:bg-zinc-800/80 dark:text-white dark:ring-zinc-700/60'
                  : 'text-zinc-600 hover:bg-zinc-200/50 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/50 dark:hover:text-zinc-100',
              )
            }
          >
            {({ isActive }) => (
              <>
                <Icon className={clsx('size-4', isActive ? 'text-accent-600 dark:text-accent-400' : 'text-zinc-400 group-hover:text-zinc-500')} />
                {label}
                {to === '/keys' && pending > 0 && (
                  <span className="ml-auto rounded-full bg-amber-500 px-1.5 text-[11px] leading-5 font-semibold text-white tabular-nums">{pending}</span>
                )}
                {to === '/events' && (
                  <span className="ml-auto" title={eventsConnected ? 'Event stream connected' : 'Event stream disconnected'}>
                    <StatusDot up={eventsConnected} />
                  </span>
                )}
              </>
            )}
          </NavLink>
        ))}
      </nav>
      <div className="border-t border-zinc-200 p-3 dark:border-zinc-800">
        <div className="flex items-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-full bg-accent-600 text-xs font-semibold text-white uppercase">{session?.user.slice(0, 2)}</div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{session?.user}</p>
            <p className="truncate text-xs text-zinc-500">
              {session?.eauth} · {session?.mode === 'demo' ? 'mock master' : session?.apiUrl}
            </p>
          </div>
          <button onClick={() => setTheme(nextTheme)} title={`Theme: ${theme}`} className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-200/60 dark:hover:bg-zinc-800">
            <ThemeIcon className="size-4" />
          </button>
          <button onClick={logout} title="Log out" className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-200/60 dark:hover:bg-zinc-800">
            <LogOut className="size-4" />
          </button>
        </div>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-zinc-200 bg-zinc-100/60 lg:block dark:border-zinc-800 dark:bg-zinc-900/40">{sidebar}</aside>

      <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-zinc-200 bg-zinc-50/90 px-4 backdrop-blur lg:hidden dark:border-zinc-800 dark:bg-zinc-950/90">
        <button onClick={() => setMobileOpen(true)} className="-ml-1 rounded-md p-1.5 hover:bg-zinc-200/60 dark:hover:bg-zinc-800" aria-label="Open menu">
          <Menu className="size-5" />
        </button>
        <Logo className="size-6" />
        <span className="font-semibold">Salt Shaker</span>
      </header>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-zinc-950/40" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 bg-zinc-50 shadow-xl dark:bg-zinc-900">
            <button onClick={() => setMobileOpen(false)} className="absolute top-4 right-3 rounded-md p-1 text-zinc-500" aria-label="Close menu">
              <X className="size-4" />
            </button>
            {sidebar}
          </aside>
        </div>
      )}

      <main className="lg:pl-60">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
