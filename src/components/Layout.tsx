import clsx from 'clsx'
import { Activity, BellRing, CalendarClock, Database, FolderTree, Gauge, History, KeyRound, LogOut, Menu, Monitor, Moon, Package, ScrollText, Search, Server, ShieldAlert, ShieldCheck, Sun, Terminal, Users, Workflow, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { useTheme } from '../lib/hooks'
import { useSalt, useSession } from '../lib/session'
import { LICENSE_NAME, SOURCE_URL, VERSION } from '../lib/about'
import { AccountModal } from './AccountModal'
import { CommandPalette } from './CommandPalette'
import { Logo } from './Logo'
import { EventNotifications } from './Toasts'
import { StatusDot } from './ui'

const nav = [
  { to: '/', label: 'Minions', icon: Server, end: true },
  { to: '/compliance', label: 'Compliance', icon: ShieldCheck },
  { to: '/patches', label: 'Patches', icon: Package },
  { to: '/keys', label: 'Enrollment', icon: KeyRound },
  { to: '/run', label: 'Run', icon: Terminal },
  { to: '/query', label: 'Query', icon: Database },
  { to: '/orchestrate', label: 'Orchestrate', icon: Workflow },
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
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
  // in server mode, eauth holds the user's Salt Shaker role
  const role = session?.mode === 'server' ? session.eauth : null
  const items = [
    // the vulnerability report is built by the server (the demo has a made-up one)
    ...nav.flatMap((n) => (n.to === '/patches' && session && session.mode !== 'live' ? [n, { to: '/vulnerabilities', label: 'Vulnerabilities', icon: ShieldAlert }] : [n])),
    ...(role === 'admin' || role === 'operator' ? [{ to: '/audit', label: 'Audit log', icon: ScrollText }] : []),
    ...(role === 'admin'
      ? [
          { to: '/schedules', label: 'Schedules', icon: CalendarClock },
          { to: '/notifications', label: 'Notifications', icon: BellRing },
          { to: '/users', label: 'Users', icon: Users },
          { to: '/system', label: 'System', icon: Gauge },
        ]
      : []),
  ]
  const pending = usePendingKeys()

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
      <div className="px-2 pt-1">
        <button
          onClick={() => {
            setMobileOpen(false)
            setPaletteOpen(true)
          }}
          className="flex w-full items-center gap-2 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-sm text-zinc-500 shadow-xs dark:text-zinc-400 hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
        >
          <Search className="size-4" />
          Search…
          <kbd className="ml-auto rounded border border-zinc-200 px-1.5 font-sans text-[10px] dark:border-zinc-700" aria-hidden>{isMac ? '⌘K' : 'Ctrl K'}</kbd>
        </button>
      </div>
      <nav className="flex-1 space-y-0.5 px-2 py-2">
        {items.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            onClick={() => setMobileOpen(false)}
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
                <Icon className={clsx('size-4', isActive ? 'text-accent-700 dark:text-accent-400' : 'text-zinc-500 group-hover:text-zinc-600 dark:text-zinc-400')} />
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
        <a href={SOURCE_URL} target="_blank" rel="noreferrer" className="mb-2.5 block px-1 text-[11px] text-zinc-600 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-300">
          v{VERSION} · {LICENSE_NAME} · Source code
        </a>
        <div className="flex items-center gap-2.5">
          <button
            onClick={() => session?.mode === 'server' && setAccountOpen(true)}
            disabled={session?.mode !== 'server'}
            title={session?.mode === 'server' ? 'Account' : undefined}
            className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg text-left enabled:hover:bg-zinc-200/50 dark:enabled:hover:bg-zinc-800/50"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-600 text-xs font-semibold text-white uppercase">{session?.user.slice(0, 2)}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{session?.user}</span>
              <span className="block truncate text-xs text-zinc-500">
                {session?.mode === 'server' ? session.eauth : `${session?.eauth} · ${session?.mode === 'demo' ? 'mock master' : session?.apiUrl}`}
              </span>
            </span>
          </button>
          <button onClick={() => setTheme(nextTheme)} title={`Theme: ${theme}`} className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 dark:text-zinc-400">
            <ThemeIcon className="size-4" />
          </button>
          <button onClick={logout} title="Log out" className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 dark:text-zinc-400">
            <LogOut className="size-4" />
          </button>
        </div>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen">
      <EventNotifications />
      <AccountModal open={accountOpen} onClose={() => setAccountOpen(false)} />
      {paletteOpen && <CommandPalette open onClose={() => setPaletteOpen(false)} pages={items} />}
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
            <button onClick={() => setMobileOpen(false)} className="absolute top-4 right-3 rounded-md p-1 text-zinc-500 dark:text-zinc-400" aria-label="Close menu">
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
