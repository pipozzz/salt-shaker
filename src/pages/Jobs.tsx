import clsx from 'clsx'
import { History, Loader2, RefreshCw, Search, Square } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { formatArgs } from '../api/salt'
import type { ActiveJob } from '../api/types'
import { StopJobModal } from '../components/StopJob'
import { Badge, Button, Card, CardHeader, Empty, ErrorBox, Input, PageHeader, PermNote, Spinner } from '../components/ui'
import { useAsync, useStoredState } from '../lib/hooks'
import { useCan, useSalt } from '../lib/session'
import { funTone, relTime } from '../lib/format'

export function JobsPage() {
  const salt = useSalt()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [showInternal, setShowInternal] = useStoredState('salt-shaker.jobs.internal', false)
  const { data, error, loading, reload: reloadJobs } = useAsync(() => salt.listJobs(), [salt])
  const active = useAsync(() => salt.activeJobs(), [salt])
  const reload = () => {
    void reloadJobs()
    void active.reload()
  }

  const rows = useMemo(() => {
    if (!data) return []
    return Object.entries(data)
      .map(([jid, j]) => ({ jid, ...j, date: salt.jidDate(jid), args: formatArgs(j.Arguments) }))
      // wheel/runner calls (including this UI's own) are noise for most people
      .filter((j) => showInternal || !isInternal(j.Function))
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
      <RunningJobs active={active.data} error={active.error} loading={active.loading} onChanged={active.reload} />
      <Card>
        <div className="flex flex-wrap items-center gap-4 border-b border-zinc-200 p-3 dark:border-zinc-800">
          <div className="relative min-w-48 flex-1">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-zinc-500 dark:text-zinc-400" />
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
                      {j['Target-type'] !== 'glob' && <span className="text-zinc-500 dark:text-zinc-400">{j['Target-type']}:</span>}
                      {Array.isArray(j.Target) ? j.Target.join(',') : j.Target}
                    </td>
                    <td className="hidden px-3 py-2.5 text-zinc-600 md:table-cell dark:text-zinc-400">{j.User}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap text-zinc-600 dark:text-zinc-400" title={j.date?.toLocaleString()}>
                      {relTime(j.date)}
                    </td>
                    <td className="hidden px-3 py-2.5 pr-4 font-mono text-xs text-zinc-500 dark:text-zinc-400 lg:table-cell">{j.jid}</td>
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

// the runner's own polling shows up as running jobs too
const isInternal = (fun: string) => fun === 'saltutil.find_job' || fun === 'saltutil.running' || /^(wheel|runner)\./.test(fun)

/** Jobs minions are still running, with a way to stop them. */
function RunningJobs({ active, error, loading, onChanged }: { active: Record<string, ActiveJob> | null | undefined; error: Error | null; loading: boolean; onChanged: () => unknown }) {
  const salt = useSalt()
  const can = useCan()
  const [stopping, setStopping] = useState<{ jid: string; fun: string; args: unknown[]; minions: string[] } | null>(null)
  const canStop = can('local', 'saltutil.kill_job')

  const rows = Object.entries(active ?? {})
    .filter(([, j]) => !isInternal(j.Function))
    .map(([jid, j]) => ({ jid, job: j, minions: j.Running.flatMap((r) => Object.keys(r)).sort(), date: salt.jidDate(jid) }))
    .sort((a, b) => b.jid.localeCompare(a.jid))

  return (
    <Card className="mb-6">
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            Running now
            {loading && <Loader2 className="size-3.5 animate-spin text-zinc-500 dark:text-zinc-400" aria-label="Checking minions" />}
          </span>
        }
        subtitle="Asks every minion what it is running (jobs.active)."
      />
      {error && (
        <div className="p-4">
          <ErrorBox error={error} onRetry={onChanged} />
        </div>
      )}
      {active && rows.length === 0 && <p className="px-4 py-3 text-sm text-zinc-500 dark:text-zinc-400">No jobs are running.</p>}
      {rows.length > 0 && (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
          {rows.map(({ jid, job, minions, date }) => (
            <li key={jid} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
              <Link to={`/jobs/${jid}`} className="rounded-md focus-visible:outline-2 focus-visible:outline-accent-500">
                <Badge tone={funTone(job.Function)} className="font-mono">
                  {job.Function}
                </Badge>
              </Link>
              <span className="max-w-64 truncate font-mono text-xs text-zinc-500 dark:text-zinc-400">{formatArgs(job.Arguments)}</span>
              <span className="text-xs text-zinc-600 dark:text-zinc-400">
                still running on <span className="font-mono">{minions.length > 3 ? `${minions.slice(0, 3).join(', ')} +${minions.length - 3}` : minions.join(', ')}</span>
              </span>
              <span className="text-xs text-zinc-500 dark:text-zinc-400" title={date?.toLocaleString()}>
                started {relTime(date)}
              </span>
              {canStop && (
                <Button size="sm" variant="danger" className="ml-auto" icon={<Square className="size-3" />} onClick={() => setStopping({ jid, fun: job.Function, args: job.Arguments, minions })}>
                  Stop
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {rows.length > 0 && !canStop && <PermNote className="border-t border-zinc-100 px-4 py-2 dark:border-zinc-800">Your role can't stop jobs.</PermNote>}

      <StopJobModal job={stopping} onClose={() => setStopping(null)} onStopped={onChanged} />
    </Card>
  )
}
