import clsx from 'clsx'
import { BookOpen, Database, Download, Play, RefreshCw, Save, Search, TriangleAlert, Trash2, Wrench } from 'lucide-react'
import { useState, type FormEvent, type KeyboardEvent } from 'react'
import { Link } from 'react-router-dom'
import { queries as queriesApi, type SavedQuery } from '../api/server'
import type { TargetType } from '../api/types'
import { TargetField } from '../components/TargetField'
import { Badge, Button, Card, CardHeader, Empty, ErrorBox, Input, PageHeader, PermNote, Spinner } from '../components/ui'
import { toCsv } from '../lib/csv'
import { download } from '../lib/export'
import { useAsync, useStoredState } from '../lib/hooks'
import { OSQUERY_INSTALL_KWARG, OSQUERY_INSTALL_SCRIPT, OSQUERY_LIBRARY, checkQuery, groupRows, osqueryCall, parseOsquery, type OsqueryRow } from '../lib/osquery'
import { useCan, useSession } from '../lib/session'
import { useJob } from '../lib/useJob'

const PAGE = 500

/** Ask minions questions in SQL with osquery: one table of rows from every minion. */
export function QueryPage() {
  const { session } = useSession()
  const can = useCan()
  const canRun = can('local', 'cmd.run')
  const server = session?.mode === 'server'
  const writer = session?.mode === 'demo' || (server && (session.eauth === 'admin' || session.eauth === 'operator'))
  const me = session?.user ?? null
  const job = useJob()
  const install = useJob()
  const [tgt, setTgt] = useStoredState('salt-shaker.query.tgt', '*')
  const [tgtType, setTgtType] = useStoredState<TargetType>('salt-shaker.query.tgtType', 'glob')
  const [sql, setSql] = useStoredState('salt-shaker.query.sql', OSQUERY_LIBRARY[0].sql)
  const [ran, setRan] = useState<string | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [filter, setFilter] = useState('')
  const [grouped, setGrouped] = useStoredState('salt-shaker.query.grouped', false)
  const [count, setCount] = useState(PAGE)
  const [saving, setSaving] = useState<string | null>(null)
  const [reloads, setReloads] = useState(0)
  const [confirmInstall, setConfirmInstall] = useState(false)
  const saved = useAsync(() => (server ? queriesApi.list().then((r) => r.queries) : Promise.resolve([] as SavedQuery[])), [server, reloads])
  const invalid = checkQuery(sql)

  const run = async (e?: FormEvent) => {
    e?.preventDefault()
    if (invalid) return
    setError(null)
    setCount(PAGE)
    try {
      const call = osqueryCall(sql)
      await job.start(tgt, tgtType, 'cmd.run', call.arg, call.kwarg)
      setRan(sql)
    } catch (err) {
      setError(err as Error)
    }
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void run()
  }

  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (!saving?.trim()) return
    setError(null)
    try {
      await queriesApi.save({ name: saving.trim(), sql })
      setSaving(null)
      setReloads((n) => n + 1)
    } catch (err) {
      setError(err as Error)
    }
  }
  const remove = async (q: SavedQuery) => {
    setError(null)
    try {
      await queriesApi.remove(q.id)
      setReloads((n) => n + 1)
    } catch (err) {
      setError(err as Error)
    }
  }

  // one row per minion and result row; a minion's error or missing osquery goes to the list below
  const r = job.run
  const rows: Array<OsqueryRow & { minion: string }> = []
  const failed: Array<{ minion: string; error: string }> = []
  const missing: string[] = []
  for (const [minion, ret] of Object.entries(r?.results ?? {}).sort((a, b) => a[0].localeCompare(b[0]))) {
    const res = parseOsquery(ret)
    if ('rows' in res) for (const row of res.rows) rows.push({ minion, ...row })
    else if (res.missing) missing.push(minion)
    else failed.push({ minion, error: res.error })
  }
  const columns = ['minion', ...new Set(rows.flatMap((row) => Object.keys(row).filter((k) => k !== 'minion')))]
  const q = filter.toLowerCase()
  const matching = q ? rows.filter((row) => Object.values(row).some((v) => v.toLowerCase().includes(q))) : rows
  // grouped: one line per distinct row, with the minions that have it in place of the minion column
  const groups = grouped ? groupRows(matching) : []
  const tableColumns = grouped ? ['minions', ...columns.slice(1)] : columns
  const shown: Array<{ row: OsqueryRow; minions: string[] }> = grouped ? groups : matching.map(({ minion, ...row }) => ({ row, minions: [minion] }))
  const answered = r ? Object.keys(r.results).length - missing.length - failed.length : 0
  const noReturn = r?.done ? r.minions.filter((m) => !(m in r.results)) : []

  const installMissing = async () => {
    setError(null)
    try {
      await install.start(missing.join(','), 'list', 'cmd.run', [OSQUERY_INSTALL_SCRIPT], { ...OSQUERY_INSTALL_KWARG })
    } catch (err) {
      setError(err as Error)
    }
  }

  const exportCsv = () => {
    const name = `osquery-${new Date().toISOString().slice(0, 10)}.csv`
    const rest = columns.slice(1)
    const table = grouped
      ? [['count', 'minions', ...rest], ...shown.map((g) => [String(g.minions.length), g.minions.join(' '), ...rest.map((c) => g.row[c] ?? '')])]
      : [columns, ...shown.map((g) => [g.minions[0], ...rest.map((c) => g.row[c] ?? '')])]
    download(name, 'text/csv', toCsv(table))
  }

  return (
    <>
      <PageHeader
        title="Query"
        description={
          <>
            Ask your minions questions in SQL with{' '}
            <a href="https://osquery.io" target="_blank" rel="noreferrer" className="text-accent-700 hover:underline dark:text-accent-400">
              osquery
            </a>
            : ports, users, processes, packages, files and more, as one table.
          </>
        }
      />

      <div className="mb-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <Card>
          <form onSubmit={run} className="space-y-3 p-4">
            <TargetField
              tgt={tgt}
              tgtType={tgtType}
              onChange={(t, tt) => {
                setTgt(t)
                setTgtType(tt)
              }}
            />
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">SQL</span>
              <textarea
                value={sql}
                onChange={(e) => setSql(e.target.value)}
                onKeyDown={onKey}
                rows={7}
                spellCheck={false}
                aria-label="SQL"
                className="w-full rounded-lg border border-zinc-200 bg-white p-3 font-mono text-sm [font-variant-ligatures:none] focus:border-accent-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-900"
              />
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" variant="primary" icon={<Play className="size-4" />} loading={!!r && !r.done} disabled={!canRun || !!invalid}>
                {r && !r.done ? `Running… ${Object.keys(r.results).length}/${r.minions.length}` : 'Run query'}
              </Button>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">{invalid && sql.trim() ? invalid : '⌘/Ctrl + Enter runs it'}</span>
              {writer && server && (
                <div className="ml-auto">
                  {saving === null ? (
                    <Button type="button" size="sm" icon={<Save className="size-3.5" />} disabled={!!invalid} onClick={() => setSaving('')}>
                      Save for the team
                    </Button>
                  ) : (
                    <span className="flex items-center gap-2">
                      <Input value={saving} onChange={(e) => setSaving(e.target.value)} placeholder="Name" aria-label="Query name" className="h-8 w-44" autoFocus onKeyDown={(e) => e.key === 'Enter' && void save(e)} />
                      <Button type="button" size="sm" variant="primary" disabled={!saving.trim()} onClick={(e) => void save(e)}>
                        Save
                      </Button>
                      <Button type="button" size="sm" onClick={() => setSaving(null)}>
                        Cancel
                      </Button>
                    </span>
                  )}
                </div>
              )}
            </div>
          </form>
          {!canRun ? (
            <PermNote className="px-4 pb-3">Your account cannot run queries; osqueryi runs through cmd.run.</PermNote>
          ) : (
            <p className="border-t border-zinc-100 px-4 py-2 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              One SELECT at a time, run with <code className="font-mono">osqueryi</code> on each minion; nothing changes. See the{' '}
              <a href="https://osquery.io/schema/" target="_blank" rel="noreferrer" className="text-accent-700 hover:underline dark:text-accent-400">
                table reference
              </a>
              .
            </p>
          )}
        </Card>

        <Card className="self-start">
          <CardHeader title={<span className="flex items-center gap-2"><BookOpen className="size-4" /> Library</span>} />
          <ul className="max-h-96 divide-y divide-zinc-100 overflow-y-auto text-sm dark:divide-zinc-800/70">
            {(saved.data ?? []).map((s) => (
              <li key={`team-${s.id}`} className="group flex items-start gap-2 px-4 py-2">
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setSql(s.sql)}>
                  <span className="block truncate font-medium">{s.name}</span>
                  <span className="block text-xs text-zinc-500 dark:text-zinc-400">saved by {s.createdBy ?? 'someone'}</span>
                </button>
                {(session?.eauth === 'admin' || s.createdBy === me) && (
                  <button type="button" aria-label={`Remove ${s.name}`} className="text-zinc-400 opacity-0 group-hover:opacity-100 hover:text-red-600 focus-visible:opacity-100" onClick={() => void remove(s)}>
                    <Trash2 className="size-3.5" />
                  </button>
                )}
              </li>
            ))}
            {OSQUERY_LIBRARY.map((l) => (
              <li key={l.name}>
                <button type="button" className={clsx('block w-full px-4 py-2 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/40', sql === l.sql && 'bg-accent-50 dark:bg-accent-950/30')} onClick={() => setSql(l.sql)}>
                  <span className="block font-medium">{l.name}</span>
                  <span className="block text-xs text-zinc-500 dark:text-zinc-400">{l.description}</span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {error && (
        <div className="mb-6">
          <ErrorBox error={error} />
        </div>
      )}

      {!r && (
        <Card>
          <Empty icon={<Database />} title="No query yet">
            Pick one from the library or write your own, then run it on a target.
          </Empty>
        </Card>
      )}

      {r && (
        <Card>
          <div className="flex flex-wrap items-center gap-3 border-b border-zinc-200 p-3 dark:border-zinc-800">
            <span className="text-sm text-zinc-600 dark:text-zinc-400">
              <strong className="text-zinc-900 dark:text-zinc-100">{rows.length}</strong> {rows.length === 1 ? 'row' : 'rows'} from {answered} of {r.minions.length} {r.minions.length === 1 ? 'minion' : 'minions'}
              {grouped && <>, {groups.length} distinct</>}
            </span>
            {ran !== null && ran !== sql && <Badge tone="amber">Query edited since</Badge>}
            <div className="relative min-w-48 flex-1">
              <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-zinc-500 dark:text-zinc-400" />
              <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter rows…" className="pl-9" />
            </div>
            <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400" title="One line per distinct row with the minions that have it, rarest first">
              <input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} className="accent-accent-600" />
              Group identical rows
            </label>
            <Button icon={<Download className="size-4" />} disabled={!shown.length} onClick={exportCsv}>
              Export CSV
            </Button>
            <Link to={`/jobs/${r.jid}`} className="font-mono text-xs text-zinc-500 hover:text-accent-600 dark:text-zinc-400">
              jid {r.jid}
            </Link>
          </div>

          {!r.done && rows.length === 0 && <Spinner label="Waiting for the minions…" />}
          {r.done && rows.length === 0 && failed.length === 0 && missing.length === 0 && <Empty icon={<Database />} title="No rows" />}

          {shown.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                    {tableColumns.map((c) => (
                      <th key={c} className="px-3 py-2.5 font-medium whitespace-nowrap first:pl-4 last:pr-4">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
                  {shown.slice(0, count).map((g, i) => (
                    <tr key={i} className="align-top">
                      {tableColumns.map((c) => (
                        <td key={c} className={clsx('max-w-md px-3 py-2 font-mono text-xs first:pl-4 last:pr-4', (c === 'minion' || c === 'minions') && 'font-medium', (g.row[c] ?? '').length > 32 ? 'break-all' : 'whitespace-nowrap')}>
                          {c === 'minion' ? (
                            <MinionLink id={g.minions[0]} />
                          ) : c === 'minions' ? (
                            <span className="flex flex-wrap items-center gap-1" title={g.minions.join(', ')}>
                              <Badge tone={g.minions.length === 1 && answered > 2 ? 'amber' : 'zinc'}>{g.minions.length}</Badge>
                              {g.minions.slice(0, 3).map((m) => (
                                <MinionLink key={m} id={m} />
                              ))}
                              {g.minions.length > 3 && <span className="font-sans text-zinc-500 dark:text-zinc-400">+{g.minions.length - 3}</span>}
                            </span>
                          ) : (
                            g.row[c]
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {shown.length > count && (
            <div className="flex items-center justify-center gap-3 border-t border-zinc-100 p-3 text-sm dark:border-zinc-800">
              <span className="text-zinc-500 dark:text-zinc-400">
                Showing {count} of {shown.length}
              </span>
              <Button size="sm" onClick={() => setCount(count + PAGE)}>
                Show more
              </Button>
            </div>
          )}

          {(missing.length > 0 || failed.length > 0 || noReturn.length > 0) && (
            <div className="space-y-2 border-t border-zinc-100 px-4 py-3 text-sm dark:border-zinc-800">
              {missing.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <Wrench className="size-4 text-amber-600" />
                  <span>
                    osquery is not installed on <span className="font-mono">{missing.join(', ')}</span>.
                  </span>
                  {canRun && !install.run && !confirmInstall && (
                    <Button size="sm" onClick={() => setConfirmInstall(true)}>
                      Install osquery…
                    </Button>
                  )}
                </div>
              )}
              {missing.length > 0 && confirmInstall && !install.run && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
                  <p>
                    Adds the official osquery repository (<code className="font-mono">pkg.osquery.io</code>, apt or dnf/yum) and installs the <code className="font-mono">osquery</code> package on {missing.length}{' '}
                    {missing.length === 1 ? 'minion' : 'minions'}. It runs no daemon; queries use <code className="font-mono">osqueryi</code>.
                  </p>
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" variant="primary" onClick={() => void installMissing()}>
                      Install on {missing.length} {missing.length === 1 ? 'minion' : 'minions'}
                    </Button>
                    <Button size="sm" onClick={() => setConfirmInstall(false)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
              {failed.map((f) => (
                <p key={f.minion} className="flex items-start gap-2 text-zinc-600 dark:text-zinc-400">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0 text-red-600" />
                  <span>
                    <span className="font-mono font-medium text-zinc-900 dark:text-zinc-100">{f.minion}</span>: {f.error}
                  </span>
                </p>
              ))}
              {noReturn.length > 0 && <p className="text-zinc-500 dark:text-zinc-400">No return from <span className="font-mono">{noReturn.join(', ')}</span>.</p>}
            </div>
          )}

          {install.run && (
            <div className="flex flex-wrap items-center gap-2 border-t border-zinc-100 px-4 py-3 text-sm dark:border-zinc-800">
              {install.run.done ? (
                <>
                  <span>
                    Installed on {Object.values(install.run.results).filter((v) => typeof v === 'string' && /osqueryi version/.test(v)).length} of {install.run.minions.length}.
                  </span>
                  {Object.entries(install.run.results)
                    .filter(([, v]) => !(typeof v === 'string' && /osqueryi version/.test(v)))
                    .map(([m]) => (
                      <Badge key={m} tone="red">
                        {m} failed
                      </Badge>
                    ))}
                  <Button size="sm" variant="primary" icon={<RefreshCw className="size-3.5" />} onClick={() => void run()}>
                    Run the query again
                  </Button>
                </>
              ) : (
                <Spinner label={`Installing osquery… ${Object.keys(install.run.results).length}/${install.run.minions.length}`} />
              )}
              <Link to={`/jobs/${install.run.jid}`} className="ml-auto font-mono text-xs text-zinc-500 hover:text-accent-600 dark:text-zinc-400">
                jid {install.run.jid}
              </Link>
            </div>
          )}
        </Card>
      )}
    </>
  )
}

function MinionLink({ id }: { id: string }) {
  return (
    <Link to={`/minions/${encodeURIComponent(id)}`} className="hover:text-accent-600">
      {id}
    </Link>
  )
}
