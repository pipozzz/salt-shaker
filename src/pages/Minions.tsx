import clsx from 'clsx'
import { CircleOff, KeyRound, RefreshCw, Search, Server, Wifi } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { Grains } from '../api/types'
import { Badge, Button, Card, Empty, ErrorBox, Input, PageHeader, Spinner, Stat, StatusDot, Tabs } from '../components/ui'
import { useAsync } from '../lib/hooks'
import { useSalt } from '../lib/session'

export function OsIcon({ os }: { os?: string }) {
  const color: Record<string, string> = { Ubuntu: 'bg-orange-500', Debian: 'bg-rose-600', Rocky: 'bg-emerald-600', CentOS: 'bg-violet-600', RedHat: 'bg-red-600', Windows: 'bg-sky-600', MacOS: 'bg-zinc-600' }
  return <span className={clsx('inline-flex size-5 items-center justify-center rounded text-[10px] font-bold text-white', color[os ?? ''] ?? 'bg-zinc-400')}>{os?.[0] ?? '?'}</span>
}

export const fmtMem = (mb?: number) => (mb ? (mb >= 1024 ? `${Math.round(mb / 1024)} GB` : `${mb} MB`) : '—')

export function MinionsPage() {
  const salt = useSalt()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'up' | 'down'>('all')

  const { data, error, loading, reload } = useAsync(async () => {
    const [status, grains, keys] = await Promise.all([salt.status(), salt.grains(), salt.keys()])
    return { status, grains, keys }
  }, [salt])

  const rows = useMemo(() => {
    if (!data) return []
    const up = new Set(data.status.up)
    return data.keys.minions
      .map((id) => ({ id, up: up.has(id), g: (data.grains[id] ?? {}) as Grains }))
      .filter((r) => (filter === 'all' ? true : filter === 'up' ? r.up : !r.up))
      .filter((r) => {
        if (!query) return true
        const hay = [r.id, r.g.os, r.g.osrelease, ...(r.g.ipv4 ?? []), ...(r.g.roles ?? [])].join(' ').toLowerCase()
        return query.toLowerCase().split(/\s+/).every((q) => hay.includes(q))
      })
      .sort((a, b) => Number(b.up) - Number(a.up) || a.id.localeCompare(b.id))
  }, [data, query, filter])

  return (
    <>
      <PageHeader
        title="Minions"
        description="Accepted minions, their status and key facts from grains."
        actions={
          <Button icon={<RefreshCw className={clsx('size-4', loading && 'animate-spin')} />} onClick={reload} disabled={loading}>
            Refresh
          </Button>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Accepted" value={data?.keys.minions.length ?? '—'} icon={<Server />} tone="accent" />
        <Stat label="Responding" value={data?.status.up.length ?? '—'} icon={<Wifi />} tone="green" />
        <Stat label="Not responding" value={data?.status.down.length ?? '—'} icon={<CircleOff />} tone={data?.status.down.length ? 'red' : 'zinc'} />
        <Link to="/keys" className="rounded-xl transition hover:ring-2 hover:ring-amber-500/30">
          <Stat
            label="Pending keys"
            value={data?.keys.minions_pre.length ?? '—'}
            icon={<KeyRound />}
            tone={data?.keys.minions_pre.length ? 'amber' : 'zinc'}
            hint={data?.keys.minions_pre.length ? 'Waiting for approval →' : undefined}
          />
        </Link>
      </div>

      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-zinc-200 p-3 dark:border-zinc-800">
          <div className="relative min-w-48 flex-1">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-zinc-400" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter by id, OS, IP or role…" className="pl-9" />
          </div>
          <Tabs
            value={filter}
            onChange={setFilter}
            items={[
              { value: 'all', label: 'All' },
              { value: 'up', label: 'Up' },
              { value: 'down', label: 'Down' },
            ]}
          />
        </div>

        {error && (
          <div className="p-4">
            <ErrorBox error={error} onRetry={reload} />
          </div>
        )}
        {!data && loading && <Spinner label="Asking minions for grains…" />}
        {data && rows.length === 0 && (
          <Empty icon={<Server />} title={data.keys.minions.length ? 'No minions match' : 'No accepted minions yet'}>
            {data.keys.minions.length ? 'Try a different filter.' : <Link className="text-accent-600 hover:underline" to="/keys">Enroll your first minion →</Link>}
          </Empty>
        )}
        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-xs font-medium text-zinc-500 dark:border-zinc-800">
                  <th className="py-2.5 pr-3 pl-4 font-medium">Minion</th>
                  <th className="px-3 py-2.5 font-medium">OS</th>
                  <th className="hidden px-3 py-2.5 font-medium md:table-cell">IP</th>
                  <th className="hidden px-3 py-2.5 font-medium lg:table-cell">CPU / RAM</th>
                  <th className="hidden px-3 py-2.5 font-medium sm:table-cell">Roles</th>
                  <th className="hidden px-3 py-2.5 pr-4 font-medium xl:table-cell">Salt</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
                {rows.map(({ id, up, g }) => (
                  <tr key={id} onClick={() => navigate(`/minions/${encodeURIComponent(id)}`)} className="cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/30">
                    <td className="py-2.5 pr-3 pl-4">
                      <div className="flex items-center gap-2.5">
                        <StatusDot up={up} />
                        <span className="font-mono font-medium">{id}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      {g.os ? (
                        <span className="flex items-center gap-2">
                          <OsIcon os={g.os} />
                          {g.os} {g.osrelease}
                        </span>
                      ) : (
                        <span className="text-zinc-400">{up ? '—' : 'offline'}</span>
                      )}
                    </td>
                    <td className="hidden px-3 py-2.5 font-mono text-xs text-zinc-600 md:table-cell dark:text-zinc-400">{g.ipv4?.find((ip) => ip !== '127.0.0.1') ?? '—'}</td>
                    <td className="hidden px-3 py-2.5 text-zinc-600 tabular-nums lg:table-cell dark:text-zinc-400">{g.num_cpus ? `${g.num_cpus} vCPU · ${fmtMem(g.mem_total)}` : '—'}</td>
                    <td className="hidden px-3 py-2.5 sm:table-cell">
                      <div className="flex flex-wrap gap-1">
                        {(Array.isArray(g.roles) ? g.roles : []).map((r) => (
                          <Badge key={r}>{r}</Badge>
                        ))}
                      </div>
                    </td>
                    <td className="hidden px-3 py-2.5 pr-4 font-mono text-xs text-zinc-500 xl:table-cell">{g.saltversion ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  )
}
