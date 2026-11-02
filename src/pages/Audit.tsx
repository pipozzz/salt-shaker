import clsx from 'clsx'
import { ChevronRight, RefreshCw, ScrollText, Search } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { auditLog, type AuditRow } from '../api/server'
import { JsonView } from '../components/JsonView'
import { Badge, Button, Card, Empty, ErrorBox, Input, PageHeader, Spinner } from '../components/ui'
import { useAsync } from '../lib/hooks'
import { relTime } from '../lib/format'

const PAGE = 100

export function AuditPage() {
  const [query, setQuery] = useState('')
  const [applied, setApplied] = useState('')
  const [older, setOlder] = useState<AuditRow[]>([])
  const [loadingMore, setLoadingMore] = useState(false)
  const first = useAsync(() => auditLog({ q: applied, limit: PAGE }), [applied])

  const rows = [...(first.data?.rows ?? []), ...older]
  const canLoadMore = (first.data?.rows.length ?? 0) === PAGE && (older.length === 0 || older.length % PAGE === 0)

  const loadMore = async () => {
    const last = rows[rows.length - 1]
    if (!last) return
    setLoadingMore(true)
    try {
      const res = await auditLog({ q: applied, before: last.id, limit: PAGE })
      setOlder((o) => [...o, ...res.rows])
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every call that could change something, who made it and how it ended — including attempts the user's role did not allow."
        actions={
          <Button
            icon={<RefreshCw className={clsx('size-4', first.loading && 'animate-spin')} />}
            onClick={() => {
              setOlder([])
              void first.reload()
            }}
          >
            Refresh
          </Button>
        }
      />
      <Card>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            setOlder([])
            setApplied(query.trim())
          }}
          className="flex gap-3 border-b border-zinc-200 p-3 dark:border-zinc-800"
        >
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-zinc-500 dark:text-zinc-400" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="User, function, target or jid…" className="pl-9" />
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
          <Empty icon={<ScrollText />} title={applied ? 'Nothing matches' : 'No entries yet'}>
            Actions taken through Salt Shaker show up here.
          </Empty>
        )}
        {rows.length > 0 && (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
            {rows.map((r) => (
              <Entry key={r.id} row={r} />
            ))}
          </ul>
        )}
        {canLoadMore && rows.length > 0 && (
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

function Entry({ row }: { row: AuditRow }) {
  const [open, setOpen] = useState(false)
  const at = new Date(row.at)
  let args: unknown = null
  try {
    args = row.args ? JSON.parse(row.args) : null
  } catch {
    args = row.args
  }
  return (
    <li>
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/30">
        <ChevronRight className={clsx('size-3.5 shrink-0 text-zinc-500 transition-transform dark:text-zinc-400', open && 'rotate-90')} />
        <span className="w-20 shrink-0 text-xs text-zinc-500 dark:text-zinc-400" title={at.toLocaleString()}>
          {relTime(at)}
        </span>
        <span className="w-28 shrink-0 truncate font-mono text-xs font-medium">{row.username}</span>
        <Badge tone={row.outcome === 'ok' ? 'green' : row.outcome === 'denied' ? 'amber' : 'red'}>{row.outcome}</Badge>
        <span className="truncate font-mono text-xs">
          {row.fun}
          {row.target && <span className="text-zinc-500 dark:text-zinc-400"> → {row.targetType && row.targetType !== 'glob' ? `${row.targetType}:` : ''}{row.target}</span>}
        </span>
        <span className="ml-auto hidden shrink-0 text-xs text-zinc-500 sm:inline dark:text-zinc-400">{row.client}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-zinc-100 bg-zinc-50/50 px-4 py-3 pl-11 text-xs dark:border-zinc-800 dark:bg-zinc-950/30">
          <p className="text-zinc-500 dark:text-zinc-400">
            {at.toLocaleString()} · role {row.role ?? '—'} {row.ip && <>· from {row.ip}</>}
            {row.jid && (
              <>
                {' '}
                ·{' '}
                <Link to={`/jobs/${row.jid}`} className="font-mono text-accent-700 hover:underline dark:text-accent-400">
                  jid {row.jid}
                </Link>
              </>
            )}
          </p>
          {row.error && <p className="text-red-600 dark:text-red-400">{row.error}</p>}
          {args !== null && <JsonView value={args} openDepth={2} />}
        </div>
      )}
    </li>
  )
}
