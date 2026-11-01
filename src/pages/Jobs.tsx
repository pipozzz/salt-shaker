import clsx from 'clsx'
import { History, RefreshCw, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { formatArgs } from '../api/salt'
import { Badge, Button, Card, Empty, ErrorBox, Input, PageHeader, Spinner } from '../components/ui'
import { useAsync, useStoredState } from '../lib/hooks'
import { useSalt } from '../lib/session'

export function relTime(d: Date | null) {
  if (!d) return '—'
  const s = Math.round((Date.now() - d.getTime()) / 1000)
  if (s < 60) return `${Math.max(s, 0)}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return d.toLocaleDateString()
}

export function funTone(fun: string) {
  if (fun.startsWith('state.')) return 'accent' as const
  if (fun.startsWith('cmd.')) return 'amber' as const
  if (fun.startsWith('test.')) return 'zinc' as const
  return 'blue' as const
}

export function JobsPage() {
  const salt = useSalt()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [showInternal, setShowInternal] = useStoredState('salt-shaker.jobs.internal', false)
  const { data, error, loading, reload } = useAsync(() => salt.listJobs(), [salt])

  const rows = useMemo(() => {
    if (!data) return []
    return Object.entries(data)
      .map(([jid, j]) => ({ jid, ...j, date: salt.jidDate(jid), args: formatArgs(j.Arguments) }))
      // wheel/runner calls (including this UI's own) are noise for most people
      .filter((j) => showInternal || !(/^(wheel|runner)\./.test(j.Function) || j.Function === 'saltutil.find_job'))
      .filter((j) => !query || `${j.jid} ${j.Function} ${j.Target} ${j.User} ${j.args}`.toLowerCase().includes(query.toLowerCase()))
      .sort((a, b) => b.jid.localeCompare(a.jid))
      .slice(0, 300)
  }, [data, query, showInternal, salt])

  return (
    <>
      <PageHeader
        title="Jobs"
        description="Recent jobs from the master's job cache."
        actions={
          <Button icon={<RefreshCw className={clsx('size-4', loading && 'animate-spin')} />} onClick={reload} disabled={loading}>
            Refresh
          </Button>
        }
      />
      <Card>
        <div className="flex flex-wrap items-center gap-4 border-b border-zinc-200 p-3 dark:border-zinc-800">
          <div className="relative min-w-48 flex-1">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-zinc-400" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter by function, target, user, jid…" className="pl-9" />
          </div>
          <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
            <input type="checkbox" checked={showInternal} onChange={(e) => setShowInternal(e.target.checked)} className="accent-accent-600" />
            Show wheel & runner calls
          </label>
        </div>
        {error && (
          <div className="p-4">
            <ErrorBox error={error} onRetry={reload} />
          </div>
        )}
        {!data && loading && <Spinner />}
        {data && rows.length === 0 && <Empty icon={<History />} title="No jobs found" />}
        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-800">
                  <th className="py-2.5 pr-3 pl-4 font-medium">Function</th>
                  <th className="px-3 py-2.5 font-medium">Target</th>
                  <th className="hidden px-3 py-2.5 font-medium md:table-cell">User</th>
                  <th className="px-3 py-2.5 font-medium">Started</th>
                  <th className="hidden px-3 py-2.5 pr-4 font-medium lg:table-cell">JID</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
                {rows.map((j) => (
                  <tr key={j.jid} onClick={() => navigate(`/jobs/${j.jid}`)} className="cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/30">
                    <td className="py-2.5 pr-3 pl-4">
                      <div className="flex items-center gap-2">
                        <Badge tone={funTone(j.Function)} className="font-mono">
                          {j.Function}
                        </Badge>
                        <span className="max-w-64 truncate font-mono text-xs text-zinc-500">{j.args}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs">
                      {j['Target-type'] !== 'glob' && <span className="text-zinc-400">{j['Target-type']}:</span>}
                      {Array.isArray(j.Target) ? j.Target.join(',') : j.Target}
                    </td>
                    <td className="hidden px-3 py-2.5 text-zinc-600 md:table-cell dark:text-zinc-400">{j.User}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap text-zinc-600 dark:text-zinc-400" title={j.date?.toLocaleString()}>
                      {relTime(j.date)}
                    </td>
                    <td className="hidden px-3 py-2.5 pr-4 font-mono text-xs text-zinc-400 lg:table-cell">{j.jid}</td>
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
