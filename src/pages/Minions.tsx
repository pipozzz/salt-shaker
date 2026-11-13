import clsx from 'clsx'
import { Bookmark, BookmarkPlus, CircleOff, Download, GitCompare, KeyRound, Play, RefreshCw, Search, Server, TriangleAlert, Wifi, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { compareVersions } from '../api/salt'
import { demoVulns } from '../api/demo-vulns'
import { history, vulns, type MinionUpdates } from '../api/server'
import type { Grains } from '../api/types'
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Modal, PageHeader, Select, Spinner, Stat, StatusDot, Tabs, type Tone } from '../components/ui'
import { download, minionsCsv } from '../lib/export'
import { CountsBadges } from './Vulnerabilities'
import { useAsync } from '../lib/hooks'
import { useSalt, useSession } from '../lib/session'
import { fmtMem, relTime } from '../lib/format'
import { filterTarget, listTarget, type Facet, type FacetKind, type Target } from '../lib/minion-target'
import { useSavedTargets } from '../lib/targets'

export function OsIcon({ os }: { os?: string }) {
  const color: Record<string, string> = { Ubuntu: 'bg-orange-500', Debian: 'bg-rose-600', Rocky: 'bg-emerald-700', CentOS: 'bg-violet-600', RedHat: 'bg-red-600', Windows: 'bg-sky-600', MacOS: 'bg-zinc-600' }
  return <span className={clsx('inline-flex size-5 items-center justify-center rounded text-[10px] font-bold text-white', color[os ?? ''] ?? 'bg-zinc-400')}>{os?.[0] ?? '?'}</span>
}

const PAGE = 100

const COMPLIANCE: Record<'ok' | 'drift' | 'error', { tone: Tone; label: string }> = {
  ok: { tone: 'green', label: 'in compliance' },
  drift: { tone: 'amber', label: 'drifted' },
  error: { tone: 'red', label: 'error' },
}

export function MinionsPage() {
  const salt = useSalt()
  const navigate = useNavigate()
  // filters live in the URL, so they survive opening a minion and coming back, and can be shared
  const [params, setParams] = useSearchParams()
  const query = params.get('q') ?? ''
  const { session } = useSession()
  const fromServer = session?.mode === 'server'
  // Drifted needs the server's compliance history
  const filter = FILTERS.find((f) => f === params.get('status') && (f !== 'drifted' || fromServer)) ?? 'all'
  const facet = parseFacet(params.get('facet'))
  // a saved target, by name: only the minions it matches
  const targetName = params.get('target')
  const { targets: savedTargets } = useSavedTargets()
  const savedTarget = targetName ? (savedTargets.find((t) => t.name === targetName) ?? null) : null
  const update = (changes: Record<string, string | null>) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        for (const [k, v] of Object.entries(changes)) {
          if (v) next.set(k, v)
          else next.delete(k)
        }
        return next
      },
      { replace: true },
    )
  const setQuery = (q: string) => update({ q })
  const setFilter = (f: Filter) => update({ status: f === 'all' ? null : f })
  const setFacet = (f: Facet | null) => update({ facet: f && `${f.kind}:${f.value}` })

  // grains come from the master's cache and render right away; who answers (manage.status pings
  // every minion and waits for the slow ones) fills in when it's ready
  const [refreshes, setRefreshes] = useState(0)
  const { data, error, loading } = useAsync(async () => {
    const [grains, keys, masterVersion] = await Promise.all([salt.fleet(refreshes > 0), salt.keys(), salt.masterVersion()])
    return { grains, keys, masterVersion }
  }, [salt, refreshes])
  const status = useAsync(() => salt.status(), [salt, refreshes])
  // who the saved target matches, from the master's cache like the Run page's preview
  const matched = useAsync(
    () => (savedTarget ? salt.matchTarget(savedTarget.tgt, savedTarget.tgtType).then((ids) => new Set(ids)) : Promise.resolve(null)),
    [salt, savedTarget?.tgt, savedTarget?.tgtType, refreshes],
  )
  // until the target is found and matched, the list waits rather than show everyone
  const targetPending = !!targetName && (!savedTarget || (!matched.data && !matched.error))
  // the latest compliance result per minion is recorded by the server
  const compliance = useAsync(() => (fromServer ? history.minionCompliance() : Promise.resolve(null)), [fromServer, refreshes])
  // and so is the latest patch scan
  const updates = useAsync(() => (fromServer ? history.minionUpdates() : Promise.resolve(null)), [fromServer, refreshes])
  // and the known vulnerabilities from the latest package inventory; the column shows once there is one
  const demo = session?.mode === 'demo'
  const vulnReport = useAsync(() => (fromServer ? vulns.minions().catch(() => null) : demo ? demoVulns.minions() : Promise.resolve(null)), [fromServer, demo, refreshes])
  const vulnBy = useMemo(() => new Map((vulnReport.data?.minions ?? []).map((m) => [m.minion, m])), [vulnReport.data])
  const showVulns = vulnBy.size > 0
  const reload = () => setRefreshes((n) => n + 1)

  const rows = useMemo(() => {
    if (!data) return []
    // drifted or failed in its latest compliance check
    const isDrifted = (id: string) => {
      const c = compliance.data?.minions[id]
      return !!c && c.status !== 'ok'
    }
    const up = status.data ? new Set(status.data.up) : null
    return data.keys.minions
      .map((id) => ({ id, up: up ? up.has(id) : undefined, g: (data.grains[id] ?? {}) as Grains }))
      .filter((r) => (filter === 'drifted' ? isDrifted(r.id) : filter === 'all' || r.up === undefined ? true : filter === 'up' ? r.up : !r.up))
      .filter((r) => !facet || facetValues(facet.kind, r.g).includes(facet.value))
      .filter((r) => !targetName || !!matched.data?.has(r.id))
      .filter((r) => {
        if (!query) return true
        const hay = [r.id, r.g.os, r.g.osrelease, ...(r.g.ipv4 ?? []), ...(r.g.roles ?? [])].join(' ').toLowerCase()
        return query.toLowerCase().split(/\s+/).every((q) => hay.includes(q))
      })
      .sort((a, b) => Number(b.up ?? 0) - Number(a.up ?? 0) || a.id.localeCompare(b.id))
  }, [data, status.data, compliance.data, query, filter, facet, targetName, matched.data])

  // render in pages; any change of filters starts again from the first page
  const filterKey = `${query}|${filter}|${facet?.kind}:${facet?.value}|${targetName}`
  const [paging, setPaging] = useState({ key: '', count: PAGE })
  const visibleCount = paging.key === filterKey ? paging.count : PAGE
  const visible = rows.slice(0, visibleCount)

  // minions picked to run something on; kept while filtering, so a selection can span searches
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const picked = data ? data.keys.minions.filter((id) => selected.has(id)).sort() : []
  const hidden = picked.filter((id) => !rows.some((r) => r.id === id)).length
  const allShown = rows.length > 0 && rows.every((r) => selected.has(r.id))
  const toggle = (ids: string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev)
      for (const id of ids) {
        if (on) next.add(id)
        else next.delete(id)
      }
      return next
    })
  const runOnPicked = () => navigate(`/run?tgt=${encodeURIComponent(picked.join(','))}&tgt_type=list`)
  // what the filters show, saved as a target: the rule when there is one, else these minions
  const [saving, setSaving] = useState(false)
  const filtered = !!(query || filter !== 'all' || facet || targetName)
  const rule = data && !query && filter === 'all' ? filterTarget({ saved: savedTarget, facet, grains: data.grains }) : null
  const onSaved = (name: string, how: 'rule' | 'list') => {
    setSaving(false)
    // the list is now that target; what it saved no longer needs its own filter
    update({ target: name, facet: null, ...(how === 'list' ? { q: null, status: null } : {}) })
  }

  // everything the filters match, not just the page shown
  const exportCsv = () =>
    download(
      `minions-${new Date().toISOString().slice(0, 10)}.csv`,
      'text/csv',
      minionsCsv(
        rows.map((r) => ({ ...r, compliance: compliance.data?.minions[r.id], updates: updates.data?.minions[r.id], vulns: vulnBy.get(r.id) })),
        fromServer,
      ),
    )

  return (
    <>
      <PageHeader
        title="Minions"
        description="Accepted minions, their status and key facts from grains."
        actions={
          <>
            <Button
              icon={<BookmarkPlus className="size-4" />}
              onClick={() => setSaving(true)}
              disabled={!filtered || !rows.length || targetPending}
              title={!filtered ? 'Filter the list first: pick a role, OS or saved target, or search' : undefined}
            >
              Save as target…
            </Button>
            <Button icon={<Download className="size-4" />} onClick={exportCsv} disabled={!rows.length} title={rows.length && data && rows.length < data.keys.minions.length ? `Exports the ${rows.length} minions the filters match` : undefined}>
              Export CSV
            </Button>
            <Button icon={<RefreshCw className={clsx('size-4', loading && 'animate-spin')} />} onClick={reload} disabled={loading}>
              Refresh
            </Button>
          </>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Accepted" value={data?.keys.minions.length ?? '—'} icon={<Server />} tone="accent" />
        <Stat label="Responding" value={status.data?.up.length ?? '—'} icon={<Wifi />} tone="green" hint={status.loading && !status.data ? 'Pinging minions…' : undefined} />
        <Stat label="Not responding" value={status.data?.down.length ?? '—'} icon={<CircleOff />} tone={status.data?.down.length ? 'red' : 'zinc'} />
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

      {data && <Fleet grains={data.grains} masterVersion={data.masterVersion} active={facet} onPick={(f) => setFacet(f && facet?.kind === f.kind && facet.value === f.value ? null : f)} />}

      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-zinc-200 p-3 dark:border-zinc-800">
          {facet && (
            <button
              onClick={() => setFacet(null)}
              className="inline-flex items-center gap-1 rounded-full bg-accent-50 px-2.5 py-1 text-xs font-medium text-accent-700 dark:bg-accent-700/20 dark:text-accent-400"
            >
              {FACET_LABEL[facet.kind]}: {facet.value}
              <X className="size-3" />
            </button>
          )}
          {targetName && (
            <span className="inline-flex items-center gap-1 rounded-full bg-accent-50 py-1 pr-1 pl-2.5 text-xs font-medium text-accent-700 dark:bg-accent-700/20 dark:text-accent-400">
              <Bookmark className="size-3" />
              <span title={savedTarget ? `${savedTarget.tgtType}: ${savedTarget.tgt}` : undefined}>{targetName}</span>
              {savedTarget && (
                <Link to={`/run?tgt=${encodeURIComponent(savedTarget.tgt)}&tgt_type=${savedTarget.tgtType}`} className="rounded-full px-1.5 hover:bg-accent-100 dark:hover:bg-accent-700/30">
                  Run on it
                </Link>
              )}
              <button onClick={() => update({ target: null })} className="rounded-full p-0.5 hover:bg-accent-100 dark:hover:bg-accent-700/30" aria-label={`Stop filtering by ${targetName}`}>
                <X className="size-3" />
              </button>
            </span>
          )}
          <div className="relative min-w-48 flex-1">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-zinc-500 dark:text-zinc-400" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter by id, OS, IP or role…" className="pl-9" />
          </div>
          {savedTargets.length > 0 && (
            <Select aria-label="Saved target" value={targetName ?? ''} onChange={(e) => update({ target: e.target.value || null })} className="max-w-56">
              <option value="">Any saved target</option>
              {targetName && !savedTarget && <option value={targetName}>{targetName}</option>}
              {savedTargets.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                </option>
              ))}
            </Select>
          )}
          <Tabs
            value={filter}
            onChange={setFilter}
            items={[
              { value: 'all', label: 'All' },
              { value: 'up', label: 'Up' },
              { value: 'down', label: 'Down' },
              ...(fromServer ? [{ value: 'drifted' as const, label: 'Drifted' }] : []),
            ]}
          />
        </div>

        {error && (
          <div className="p-4">
            <ErrorBox error={error} onRetry={reload} />
          </div>
        )}
        {!data && loading && <Spinner label="Asking minions for grains…" />}
        {targetName && matched.error && (
          <div className="p-4">
            <ErrorBox error={matched.error} onRetry={reload} />
          </div>
        )}
        {data && targetPending && !matched.error && (savedTarget ? <Spinner label={`Finding who ${targetName} matches…`} /> : <Empty icon={<Bookmark />} title={`No saved target is called ${targetName}`}>It may have been removed. Pick another, or clear it.</Empty>)}
        {data && !targetPending && rows.length === 0 && (
          <Empty icon={<Server />} title={!data.keys.minions.length ? 'No accepted minions yet' : filter === 'drifted' && !query && !facet ? 'Nothing drifted' : 'No minions match'}>
            {!data.keys.minions.length ? (
              <Link className="text-accent-700 hover:underline" to="/keys">
                Enroll your first minion →
              </Link>
            ) : filter === 'drifted' && !query && !facet ? (
              'Every minion was in compliance in its latest check.'
            ) : (
              'Try a different filter.'
            )}
          </Empty>
        )}
        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-xs font-medium text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                  <th className="w-0 py-2.5 pr-1 pl-4">
                    <Check
                      label={allShown ? 'Deselect all shown minions' : `Select all ${rows.length} shown minions`}
                      checked={allShown}
                      indeterminate={!allShown && rows.some((r) => selected.has(r.id))}
                      onChange={(on) => toggle(rows.map((r) => r.id), on)}
                    />
                  </th>
                  <th className="py-2.5 pr-3 pl-2 font-medium">Minion</th>
                  <th className="px-3 py-2.5 font-medium">OS</th>
                  {fromServer && <th className="hidden px-3 py-2.5 font-medium sm:table-cell">Compliance</th>}
                  {fromServer && <th className="hidden px-3 py-2.5 font-medium md:table-cell">Updates</th>}
                  {showVulns && <th className="hidden px-3 py-2.5 font-medium lg:table-cell">Vulnerabilities</th>}
                  <th className="hidden px-3 py-2.5 font-medium md:table-cell">IP</th>
                  <th className="hidden px-3 py-2.5 font-medium lg:table-cell">CPU / RAM</th>
                  <th className="hidden px-3 py-2.5 font-medium sm:table-cell">Roles</th>
                  <th className="hidden px-3 py-2.5 pr-4 font-medium xl:table-cell">Salt</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
                {visible.map(({ id, up, g }) => (
                  <tr key={id} onClick={() => navigate(`/minions/${encodeURIComponent(id)}`, { state: { back: params.toString() } })} className="cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/30">
                    <td className="py-2.5 pr-1 pl-4" onClick={(e) => e.stopPropagation()}>
                      <Check label={`Select ${id}`} checked={selected.has(id)} onChange={(on) => toggle([id], on)} />
                    </td>
                    <td className="py-2.5 pr-3 pl-2">
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
                        <span className="text-zinc-500 dark:text-zinc-400">{up ? '—' : 'offline'}</span>
                      )}
                    </td>
                    {fromServer && (
                      <td className="hidden px-3 py-2.5 sm:table-cell">
                        <ComplianceBadge c={compliance.data?.minions[id]} loading={!compliance.data && !compliance.error} />
                      </td>
                    )}
                    {fromServer && (
                      <td className="hidden px-3 py-2.5 md:table-cell">
                        <UpdatesBadge u={updates.data?.minions[id]} loading={!updates.data && !updates.error} />
                      </td>
                    )}
                    {showVulns && (
                      <td className="hidden px-3 py-2.5 lg:table-cell">
                        <VulnsCell m={vulnBy.get(id)} />
                      </td>
                    )}
                    <td className="hidden px-3 py-2.5 font-mono text-xs text-zinc-600 md:table-cell dark:text-zinc-400">{g.ipv4?.find((ip) => ip !== '127.0.0.1') ?? '—'}</td>
                    <td className="hidden px-3 py-2.5 text-zinc-600 tabular-nums lg:table-cell dark:text-zinc-400">{g.num_cpus ? `${g.num_cpus} vCPU · ${fmtMem(g.mem_total)}` : '—'}</td>
                    <td className="hidden px-3 py-2.5 sm:table-cell">
                      <div className="flex flex-wrap gap-1">
                        {(Array.isArray(g.roles) ? g.roles : []).map((r) => (
                          <Badge key={r}>{r}</Badge>
                        ))}
                      </div>
                    </td>
                    <td className="hidden px-3 py-2.5 pr-4 font-mono text-xs text-zinc-500 xl:table-cell dark:text-zinc-400">{g.saltversion ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rows.length > visible.length && (
          <div className="flex items-center justify-center gap-3 border-t border-zinc-100 p-3 text-sm dark:border-zinc-800">
            <span className="text-zinc-500 dark:text-zinc-400">
              Showing {visible.length} of {rows.length}
            </span>
            <Button size="sm" onClick={() => setPaging({ key: filterKey, count: visibleCount + PAGE })}>
              Show {Math.min(PAGE, rows.length - visible.length)} more
            </Button>
          </div>
        )}
        {/* at the bottom, so selecting doesn't push the rows down under the pointer */}
        {picked.length > 0 && (
          <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-3 rounded-b-xl border-t border-zinc-200 bg-white/95 px-4 py-2 text-sm backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/95">
            <span className="font-medium">
              {picked.length} selected
              {hidden > 0 && <span className="font-normal text-zinc-500 dark:text-zinc-400"> ({hidden} not shown by the filter)</span>}
            </span>
            <Button size="sm" variant="primary" icon={<Play className="size-3.5" />} onClick={runOnPicked}>
              Run on selected
            </Button>
            {picked.length === 2 && (
              <Button size="sm" icon={<GitCompare className="size-3.5" />} onClick={() => navigate(`/minions/compare?${new URLSearchParams({ a: picked[0], b: picked[1] })}`)}>
                Compare
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
        )}

        {status.error && <p className="border-t border-zinc-100 px-4 py-2 text-xs text-amber-700 dark:border-zinc-800 dark:text-amber-400">Couldn't check which minions respond: {status.error.message}</p>}
      </Card>

      {saving && data && <SaveTargetModal rule={rule} ids={rows.map((r) => r.id)} why={query ? 'search' : filter !== 'all' ? 'status' : 'parts'} onClose={() => setSaving(false)} onSaved={onSaved} />}
    </>
  )
}

/**
 * Names what the list shows as a saved target, for Run, schedules and the other pages that take
 * one: the rule, so minions that match later count too, or just these minions.
 */
function SaveTargetModal({ rule, ids, why, onClose, onSaved }: { rule: Target | null; ids: string[]; why: 'search' | 'status' | 'parts'; onClose: () => void; onSaved: (name: string, how: 'rule' | 'list') => void }) {
  const { targets, save } = useSavedTargets()
  const [name, setName] = useState('')
  const [how, setHow] = useState<'rule' | 'list'>(rule ? 'rule' : 'list')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const list = listTarget(ids)
  const target = how === 'rule' ? rule : list
  const taken = targets.some((t) => t.name === name.trim())
  const n = ids.length === 1 ? '1 minion' : `${ids.length} minions`
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !target) return
    setBusy(true)
    setError(null)
    save(name.trim(), target.tgt, target.tgtType).then(
      () => onSaved(name.trim(), how),
      (err: unknown) => {
        setBusy(false)
        setError(err instanceof Error ? err.message : String(err))
      },
    )
  }
  const code = (t: Target) => (
    <code className="font-mono text-xs break-all">
      {t.tgtType !== 'glob' && `${t.tgtType}: `}
      {t.tgt}
    </code>
  )
  return (
    <Modal open onClose={onClose} title="Save as target">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name" hint={taken ? 'A saved target has this name; saving replaces it.' : 'Run, schedules and the other pages that take a target list it.'}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus placeholder="Ubuntu web servers" />
        </Field>
        {rule ? (
          <fieldset className="space-y-2 text-sm">
            <legend className="mb-1.5 text-xs font-medium text-zinc-600 dark:text-zinc-400">What it saves</legend>
            <label className="flex items-start gap-2">
              <input type="radio" name="how" className="mt-1" checked={how === 'rule'} onChange={() => setHow('rule')} />
              <span>
                Whoever matches {code(rule)}
                <span className="block text-xs text-zinc-500 dark:text-zinc-400">Minions added later count too.</span>
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input type="radio" name="how" className="mt-1" checked={how === 'list'} onChange={() => setHow('list')} disabled={!list} />
              <span>
                Just these {n}
                <span className="block text-xs text-zinc-500 dark:text-zinc-400">{list ? 'As a list, the same minions every time.' : 'Too many to keep as a list.'}</span>
              </span>
            </label>
          </fieldset>
        ) : (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {why === 'search'
              ? 'The search isn’t a target Salt can read'
              : why === 'status'
                ? 'Up, Down and Drifted change from moment to moment'
                : 'A grain here has a space in it, which a target can’t hold'}
            , so this saves {list ? <>the {n} the list shows now, as a list.</> : <>the minions the list shows, but there are too many for a list. Narrow it down, or save a role, OS or saved target without the search.</>}
          </p>
        )}
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!name.trim() || !target || busy}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  )
}

/** A row checkbox with a larger click area than the box itself. */
function Check({ label, checked, indeterminate = false, onChange }: { label: string; checked: boolean; indeterminate?: boolean; onChange: (on: boolean) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate
  }, [indeterminate])
  return (
    <label className="-m-2 flex cursor-pointer p-2">
      <input ref={ref} type="checkbox" aria-label={label} checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-4 cursor-pointer accent-accent-600" />
    </label>
  )
}

function ComplianceBadge({ c, loading }: { c?: { status: 'ok' | 'drift' | 'error'; jid: string; checkedAt: string }; loading: boolean }) {
  if (!c) return <span className="text-xs text-zinc-500 dark:text-zinc-400">{loading ? '' : 'not checked'}</span>
  const at = new Date(c.checkedAt)
  const { tone, label } = COMPLIANCE[c.status]
  return (
    <Link
      to={`/jobs/${c.jid}`}
      onClick={(e) => e.stopPropagation()}
      title={`Checked ${relTime(at)} (${at.toLocaleString()})`}
      className="rounded-md focus-visible:outline-2 focus-visible:outline-accent-500"
    >
      <Badge tone={tone}>{label}</Badge>
    </Link>
  )
}

function VulnsCell({ m }: { m?: { minion: string; error: string | null; counts: Parameters<typeof CountsBadges>[0]['counts'] } }) {
  if (!m) return <span className="text-xs text-zinc-500 dark:text-zinc-400">not scanned</span>
  if (m.error) return <span className="text-xs text-zinc-500 dark:text-zinc-400" title={m.error}>not covered</span>
  return (
    <Link to={`/minions/${encodeURIComponent(m.minion)}?tab=vulns`} onClick={(e) => e.stopPropagation()} className="rounded-md focus-visible:outline-2 focus-visible:outline-accent-500">
      <CountsBadges counts={m.counts} />
    </Link>
  )
}

function UpdatesBadge({ u, loading }: { u?: MinionUpdates; loading: boolean }) {
  if (!u) return <span className="text-xs text-zinc-500 dark:text-zinc-400">{loading ? '' : 'not scanned'}</span>
  const at = new Date(u.checkedAt)
  return (
    <Link
      to={`/jobs/${u.jid}`}
      onClick={(e) => e.stopPropagation()}
      title={`Scanned ${relTime(at)} (${at.toLocaleString()})`}
      className="rounded-md focus-visible:outline-2 focus-visible:outline-accent-500"
    >
      {u.packages ? <Badge tone="amber">{u.packages === 1 ? '1 package' : `${u.packages} packages`}</Badge> : <Badge tone="green">up to date</Badge>}
    </Link>
  )
}

const FACET_LABEL: Record<FacetKind, string> = { os: 'OS', salt: 'Salt', role: 'Role' }

const FILTERS = ['all', 'up', 'down', 'drifted'] as const
type Filter = (typeof FILTERS)[number]

/** `os:Ubuntu` from the URL; anything else is ignored. */
function parseFacet(s: string | null): Facet | null {
  const i = s?.indexOf(':') ?? -1
  const kind = s?.slice(0, i)
  return s && i > 0 && kind && kind in FACET_LABEL ? { kind: kind as FacetKind, value: s.slice(i + 1) } : null
}

function facetValues(kind: FacetKind, g: Grains): string[] {
  if (kind === 'os') return g.os ? [`${g.os} ${g.osrelease ?? ''}`.trim()] : []
  if (kind === 'salt') return g.saltversion ? [g.saltversion] : []
  return Array.isArray(g.roles) ? g.roles.map(String) : []
}

function countBy(grains: Record<string, Grains>, kind: FacetKind) {
  const counts = new Map<string, number>()
  for (const g of Object.values(grains)) {
    if (!g || typeof g !== 'object') continue
    for (const v of facetValues(kind, g)) counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  return [...counts.entries()]
}

/** Fleet breakdown by OS, Salt version and role; rows filter the table below. */
function Fleet({ grains, masterVersion, active, onPick }: { grains: Record<string, Grains>; masterVersion: string | null; active: Facet | null; onPick: (f: Facet) => void }) {
  const os = countBy(grains, 'os').sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const salt = countBy(grains, 'salt').sort((a, b) => compareVersions(b[0], a[0]))
  const roles = countBy(grains, 'role').sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  // without the master's version, compare against the newest minion
  const reference = masterVersion ?? salt[0]?.[0]
  const behind = salt.filter(([v]) => reference && compareVersions(v, reference) < 0).reduce((n, [, c]) => n + c, 0)
  if (os.length + salt.length + roles.length === 0) return null

  return (
    <div className="mb-6 grid gap-3 lg:grid-cols-3">
      <Breakdown title="Operating systems" kind="os" rows={os} active={active} onPick={onPick} />
      <Breakdown
        title="Salt versions"
        subtitle={
          behind ? (
            <span className="flex items-center gap-1 text-amber-700 dark:text-amber-400">
              <TriangleAlert className="size-3.5" /> {behind} {behind === 1 ? 'minion is' : 'minions are'} behind {masterVersion ? `the master (${masterVersion})` : reference}
            </span>
          ) : (
            masterVersion && `All match the master (${masterVersion})`
          )
        }
        kind="salt"
        rows={salt}
        active={active}
        onPick={onPick}
        flag={(v) => (reference && compareVersions(v, reference) < 0 ? 'behind' : null)}
      />
      <Breakdown title="Roles" subtitle={roles.length === 0 ? 'No roles grain set' : undefined} kind="role" rows={roles} active={active} onPick={onPick} />
    </div>
  )
}

function Breakdown({
  title,
  subtitle,
  kind,
  rows,
  active,
  onPick,
  flag,
}: {
  title: string
  subtitle?: React.ReactNode
  kind: FacetKind
  rows: Array<[string, number]>
  active: Facet | null
  onPick: (f: Facet) => void
  flag?: (value: string) => string | null
}) {
  const max = Math.max(1, ...rows.map(([, c]) => c))
  const shown = rows.slice(0, 6)
  return (
    <Card className="p-4">
      <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{title}</p>
      {subtitle && <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{subtitle}</div>}
      <ul className="mt-3 space-y-1">
        {shown.map(([value, count]) => {
          const isActive = active?.kind === kind && active.value === value
          const note = flag?.(value)
          return (
            <li key={value}>
              <button
                onClick={() => onPick({ kind, value })}
                aria-pressed={isActive}
                className={clsx('w-full rounded-md px-2 py-1 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800/60', isActive && 'bg-accent-50 ring-1 ring-accent-500/40 dark:bg-accent-700/20')}
              >
                <div className="flex items-center gap-2 text-sm">
                  <span className={clsx('truncate', kind === 'salt' && 'font-mono text-xs')}>{value}</span>
                  {note && (
                    <span className="inline-flex items-center gap-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
                      <TriangleAlert className="size-3" /> {note}
                    </span>
                  )}
                  <span className="ml-auto text-xs text-zinc-600 tabular-nums dark:text-zinc-400">{count}</span>
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800">
                  <div className="h-full rounded-full bg-accent-500 dark:bg-accent-400" style={{ width: `${(count / max) * 100}%` }} />
                </div>
              </button>
            </li>
          )
        })}
      </ul>
      {rows.length > shown.length && <p className="mt-2 px-2 text-xs text-zinc-500 dark:text-zinc-400">+{rows.length - shown.length} more</p>}
    </Card>
  )
}
