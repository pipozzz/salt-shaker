import clsx from 'clsx'
import { History, RefreshCw, Search } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { formatArgs } from '../api/salt'
import { history, parseStoredArgs, type HistoryJob } from '../api/server'
import { Badge, Button, Card, Empty, ErrorBox, Input, PageHeader, Spinner } from '../components/ui'
import { useAsync, useUrlSearch } from '../lib/hooks'
import { funTone, relTime } from '../lib/format'

const PAGE = 100
const FIELDS = ['q'] as const

/** Jobs from the server's database: longer history than the master's cache, with who ran them. */
export function JobHistoryPage() {
  const navigate = useNavigate()
  const search = useUrlSearch(FIELDS)
  const applied = search.applied.q
  // older pages belong to the search they were loaded for
  const [olderPages, setOlderPages] = useState<{ key: string; rows: HistoryJob[] }>({ key: '', rows: [] })
  const older = olderPages.key === search.key ? olderPages.rows : []
  const [loadingMore, setLoadingMore] = useState(false)
  const first = useAsync(() => history.jobs({ q: applied, limit: PAGE }), [applied])
  const refresh = () => {
    setOlderPages({ key: '', rows: [] })
    void first.reload()
  }

  const rows = [...(first.data?.rows ?? []), ...older]
  const more = (first.data?.rows.length ?? 0) === PAGE && older.length % PAGE === 0

  const loadMore = async () => {
    const last = rows[rows.length - 1]
    if (!last) return
    setLoadingMore(true)
    try {
      const res = await history.jobs({ q: applied, before: Date.parse(last.startedAt), limit: PAGE })
      setOlderPages({ key: search.key, rows: [...older, ...res.rows] })
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <>
      <PageHeader
        title="Jobs"
        description={
          <>
            Recorded from the master's event bus and kept for {first.data?.retentionDays ?? '…'} days.{' '}
            <Link to="/jobs?source=master" className="text-accent-700 hover:underline dark:text-accent-400">
              Master's job cache
            </Link>
          </>
        }
        actions={
          <Button
            icon={<RefreshCw className={clsx('size-4', first.loading && 'animate-spin')} />}
            onClick={refresh}
          >
            Refresh
          </Button>
        }
      />
      <Card>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (!search.apply()) refresh()
          }}
          className="flex gap-3 border-b border-zinc-200 p-3 dark:border-zinc-800"
        >
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-zinc-500 dark:text-zinc-400" />
            <Input value={search.form.q} onChange={(e) => search.set('q', e.target.value)} aria-label="Search" placeholder="Function, target, user or jid…" className="pl-9" />
          </div>
          <Button type="submit">Search</Button>
        </form>
        {first.error && (
          <div className="p-4">
            <ErrorBox error={first.error} onRetry={first.reload} />
          </div>
        )}
        {first.loading && !first.data && <Spinner />}
        {first.data && rows.length === 0 && (
          <Empty icon={<History />} title={applied ? 'Nothing matches' : 'No jobs recorded yet'}>
            Jobs show up here as soon as they run, whether started here or from the salt CLI.
          </Empty>
        )}
        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                  <th className="py-2.5 pr-3 pl-4 font-medium">Function</th>
                  <th className="px-3 py-2.5 font-medium">Target</th>
                  <th className="hidden px-3 py-2.5 font-medium md:table-cell">By</th>
                  <th className="px-3 py-2.5 font-medium">Result</th>
                  <th className="px-3 py-2.5 pr-4 font-medium">Started</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
                {rows.map((j) => {
                  const expected = (JSON.parse(j.minions ?? '[]') as string[]).length
                  const at = new Date(j.startedAt)
                  return (
                    <tr key={j.jid} onClick={() => navigate(`/jobs/${j.jid}`)} className="cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/30">
                      <td className="py-2.5 pr-3 pl-4">
                        <div className="flex items-center gap-2">
                          <Badge tone={funTone(j.fun)} className="font-mono">
                            {j.fun}
                          </Badge>
                          {j.dryRun && <Badge tone="amber">dry run</Badge>}
                          <span className="max-w-64 truncate font-mono text-xs text-zinc-500 dark:text-zinc-400">{formatArgs(parseStoredArgs(j.args)).replace(/\s*test=True/, '')}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 font-mono text-xs">
                        {j.targetType && j.targetType !== 'glob' && <span className="text-zinc-500 dark:text-zinc-400">{j.targetType}:</span>}
                        {j.target ?? '—'}
                      </td>
                      <td className="hidden px-3 py-2.5 md:table-cell">
                        {j.shakerUser ? (
                          <span className="font-medium">{j.shakerUser}</span>
                        ) : (
                          <span className="text-zinc-500 dark:text-zinc-400" title="Not started through Salt Shaker (e.g. the salt CLI)">
                            {j.saltUser ?? '—'} <span className="text-xs">(salt)</span>
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <span className="text-xs text-zinc-600 tabular-nums dark:text-zinc-400">
                          {j.returned}/{Math.max(expected, j.returned)}
                        </span>{' '}
                        {j.failed > 0 && <Badge tone="red">{j.failed} failed</Badge>}
                      </td>
                      <td className="px-3 py-2.5 pr-4 whitespace-nowrap text-zinc-600 dark:text-zinc-400" title={at.toLocaleString()}>
                        {relTime(at)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {more && rows.length > 0 && (
          <div className="border-t border-zinc-100 p-3 text-center dark:border-zinc-800">
            <Button size="sm" loading={loadingMore} onClick={loadMore}>
              Load older
            </Button>
          </div>
        )}
      </Card>
    </>
  )
}
