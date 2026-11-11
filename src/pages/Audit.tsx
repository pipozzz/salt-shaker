import clsx from 'clsx'
import { ChevronRight, Download, RefreshCw, ScrollText, Search } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { demoAudit } from '../api/demo-audit'
import { auditExportUrl, auditLog, type AuditFilter, type AuditRow } from '../api/server'
import { JsonView } from '../components/JsonView'
import { Badge, Button, ButtonLink, Card, Empty, ErrorBox, Input, PageHeader, Select, Spinner } from '../components/ui'
import { useAsync, useUrlSearch } from '../lib/hooks'
import { relTime } from '../lib/format'
import { download } from '../lib/export'
import { useSession } from '../lib/session'

const PAGE = 100
const FIELDS = ['q', 'outcome', 'from', 'to'] as const
const OUTCOMES = ['ok', 'denied', 'error'] as const

export function AuditPage() {
  const { session } = useSession()
  // the demo keeps its own log in the browser
  const demo = session?.mode === 'demo'
  const list = demo ? demoAudit.list : auditLog
  const search = useUrlSearch(FIELDS)
  const { form } = search
  // the URL may say anything; an unknown outcome means any
  const applied: AuditFilter = { ...search.applied, outcome: OUTCOMES.find((o) => o === search.applied.outcome) ?? '' }
  // older pages belong to the search they were loaded for
  const [olderPages, setOlderPages] = useState<{ key: string; rows: AuditRow[] }>({ key: '', rows: [] })
  const older = olderPages.key === search.key ? olderPages.rows : []
  const [loadingMore, setLoadingMore] = useState(false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const first = useAsync(() => list({ ...applied, limit: PAGE }), [search.key, demo])
  const filtered = Object.values(applied).some(Boolean)
  const set = (k: (typeof FIELDS)[number]) => (e: { target: { value: string } }) => search.set(k, e.target.value)
  const refresh = () => {
    setOlderPages({ key: '', rows: [] })
    void first.reload()
  }

  const rows = [...(first.data?.rows ?? []), ...older]
  const canLoadMore = (first.data?.rows.length ?? 0) === PAGE && (older.length === 0 || older.length % PAGE === 0)

  const loadMore = async () => {
    const last = rows[rows.length - 1]
    if (!last) return
    setLoadingMore(true)
    try {
      const res = await list({ ...applied, before: last.id, limit: PAGE })
      setOlderPages({ key: search.key, rows: [...older, ...res.rows] })
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
          <>
            {demo ? (
              <Button icon={<Download className="size-4" />} onClick={() => download(`audit-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv', demoAudit.csv(applied))}>
                Export CSV
              </Button>
            ) : (
              <ButtonLink href={auditExportUrl(applied)} download icon={<Download className="size-4" />} title={filtered ? 'Every entry matching the filter, as CSV' : 'Every entry, as CSV'}>
                Export CSV
              </ButtonLink>
            )}
            <Button
              icon={<RefreshCw className={clsx('size-4', first.loading && 'animate-spin')} />}
              onClick={refresh}
            >
              Refresh
            </Button>
          </>
        }
      />
      <Card>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (!search.apply()) refresh()
          }}
          className="flex flex-wrap gap-3 border-b border-zinc-200 p-3 dark:border-zinc-800"
        >
          <div className="relative w-full sm:w-auto sm:min-w-48 sm:flex-1">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-zinc-500 dark:text-zinc-400" />
            <Input value={form.q} onChange={set('q')} placeholder="User, function, target or jid…" aria-label="Search" className="pl-9" />
          </div>
          <Select value={form.outcome} onChange={set('outcome')} aria-label="Outcome" className="sm:w-40">
            <option value="">Any outcome</option>
            <option value="ok">ok</option>
            <option value="denied">denied</option>
            <option value="error">error</option>
          </Select>
          <Input type="date" value={form.from} onChange={set('from')} aria-label="From (UTC)" title="From (UTC)" className="sm:w-40" />
          <Input type="date" value={form.to} onChange={set('to')} aria-label="To (UTC)" title="To (UTC), inclusive" className="sm:w-40" />
          <Button type="submit">Search</Button>
        </form>
        {first.error && (
          <div className="p-4">
            <ErrorBox error={first.error} onRetry={first.reload} />
          </div>
        )}
        {first.loading && !first.data && <Spinner />}
        {first.data && rows.length === 0 && (
          <Empty icon={<ScrollText />} title={filtered ? 'Nothing matches' : 'No entries yet'}>
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
      {/* on a phone the call goes on its own line, so it isn't cut down to a few letters */}
      <button onClick={() => setOpen(!open)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-left text-sm hover:bg-zinc-50 sm:flex-nowrap dark:hover:bg-zinc-800/30">
        <ChevronRight className={clsx('size-3.5 shrink-0 text-zinc-500 transition-transform dark:text-zinc-400', open && 'rotate-90')} />
        <span className="w-20 shrink-0 text-xs text-zinc-500 dark:text-zinc-400" title={at.toLocaleString()}>
          {relTime(at)}
        </span>
        <span className="w-28 shrink-0 truncate font-mono text-xs font-medium">{row.username}</span>
        <Badge tone={row.outcome === 'ok' ? 'green' : row.outcome === 'denied' ? 'amber' : 'red'}>{row.outcome}</Badge>
        <span className="w-full min-w-0 truncate pl-[1.625rem] font-mono text-xs sm:w-auto sm:pl-0">
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
