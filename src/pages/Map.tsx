import clsx from 'clsx'
import { CircleCheck, CircleDashed, CircleX, Network, RefreshCw, TriangleAlert } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { demoVulns } from '../api/demo-vulns'
import { history, vulns } from '../api/server'
import type { Grains } from '../api/types'
import { Button, Card, Empty, ErrorBox, Field, PageHeader, Select, Spinner } from '../components/ui'
import { useAsync, useStoredState } from '../lib/hooks'
import { GROUPINGS, layout, LEVEL_WORDS, levelCounts, levelOf, OVERLAYS, type Grouping, type Level, type MapState, type Overlay, type Tile } from '../lib/infra'
import { useSalt, useSession } from '../lib/session'

const LEVEL_STYLE: Record<Level, { tile: string; icon: ReactNode }> = {
  good: { tile: 'border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/50', icon: <CircleCheck className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" /> },
  warning: { tile: 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/50', icon: <TriangleAlert className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" /> },
  critical: { tile: 'border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/50', icon: <CircleX className="size-3.5 shrink-0 text-red-600 dark:text-red-400" /> },
  unknown: { tile: 'border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900', icon: <CircleDashed className="size-3.5 shrink-0 text-zinc-400" /> },
}
const LEVELS: Level[] = ['critical', 'warning', 'good', 'unknown']
const BAR: Record<Level, string> = { critical: 'bg-red-500', warning: 'bg-amber-400', good: 'bg-emerald-500', unknown: 'bg-zinc-300 dark:bg-zinc-600' }

/** A thin bar of how a group's minions split over the levels; the words are on the tiles and in the legend. */
function LevelBar({ counts, total }: { counts: Record<Level, number>; total: number }) {
  return (
    <div className="mb-2 flex h-1.5 gap-0.5 overflow-hidden rounded-full" aria-hidden>
      {LEVELS.filter((l) => counts[l]).map((l) => (
        <div key={l} className={BAR[l]} style={{ width: `${(100 * counts[l]) / total}%` }} />
      ))}
    </div>
  )
}

/** The fleet as a picture: minions in nested groups by what they share, coloured by one state at a time. */
export function MapPage() {
  const salt = useSalt()
  const { session } = useSession()
  const fromServer = session?.mode === 'server'
  const demo = session?.mode === 'demo'
  const [outer, setOuter] = useStoredState<Grouping>('salt-shaker.map.outer', 'subnet')
  const [inner, setInner] = useStoredState<Grouping>('salt-shaker.map.inner', 'role')
  const [overlay, setOverlay] = useStoredState<Overlay>('salt-shaker.map.overlay', 'status')
  const [reloads, setReloads] = useState(0)

  const fleet = useAsync(async () => {
    const [grains, keys, masterVersion] = await Promise.all([salt.fleet(false), salt.keys(), salt.masterVersion()])
    return { grains, keys, masterVersion }
  }, [salt, reloads])
  const status = useAsync(() => salt.status(), [salt, reloads])
  const compliance = useAsync(() => (fromServer ? history.minionCompliance() : Promise.resolve(null)), [fromServer, reloads])
  const vulnReport = useAsync(() => (fromServer ? vulns.minions().catch(() => null) : demo ? demoVulns.minions() : Promise.resolve(null)), [fromServer, demo, reloads])

  const overlays = (Object.keys(OVERLAYS) as Overlay[]).filter((o) => o !== 'compliance' || fromServer)
  const shown: Overlay = overlays.includes(overlay) ? overlay : 'status'

  const tiles: Tile[] = useMemo(() => (fleet.data ? fleet.data.keys.minions.map((id) => ({ id, g: (fleet.data!.grains[id] ?? {}) as Grains })) : []), [fleet.data])
  const groups = useMemo(() => layout(tiles, outer, inner), [tiles, outer, inner])
  const state: MapState = {
    up: status.data ? new Set(status.data.up) : null,
    compliance: compliance.data?.minions ?? null,
    vulns: vulnReport.data ? new Map(vulnReport.data.minions.map((m) => [m.minion, { critical: m.counts.critical, high: m.counts.high }])) : null,
    masterVersion: fleet.data?.masterVersion ?? null,
  }
  const counts = levelCounts(shown, tiles, state)

  return (
    <>
      <PageHeader
        title="Map"
        description="Your minions as a picture: grouped by what they share, coloured by how they're doing. Pick what to group by and what the colours show; open a minion from its tile."
        actions={
          <Button icon={<RefreshCw className="size-4" />} onClick={() => setReloads((n) => n + 1)} loading={fleet.loading || status.loading}>
            Refresh
          </Button>
        }
      />

      <Card className="mb-6">
        <div className="flex flex-wrap items-end gap-3 p-4">
          <Field label="Group by">
            <Select value={outer} onChange={(e) => setOuter(e.target.value as Grouping)} aria-label="Group by">
              {(Object.keys(GROUPINGS) as Grouping[]).filter((k) => k !== 'none').map((k) => (
                <option key={k} value={k}>
                  {GROUPINGS[k]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Then by">
            <Select value={inner} onChange={(e) => setInner(e.target.value as Grouping)} aria-label="Then by">
              {(Object.keys(GROUPINGS) as Grouping[]).filter((k) => k !== outer).map((k) => (
                <option key={k} value={k}>
                  {GROUPINGS[k]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Colour by">
            <Select value={shown} onChange={(e) => setOverlay(e.target.value as Overlay)} aria-label="Colour by">
              {overlays.map((k) => (
                <option key={k} value={k}>
                  {OVERLAYS[k]}
                </option>
              ))}
            </Select>
          </Field>
          {/* the legend: every level with its words and how many minions are at it */}
          <ul className="ml-auto flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-600 dark:text-zinc-400" aria-label="Legend">
            {LEVELS.filter((l) => counts[l] > 0 && LEVEL_WORDS[shown][l]).map((l) => (
              <li key={l} className="flex items-center gap-1.5">
                {LEVEL_STYLE[l].icon}
                {LEVEL_WORDS[shown][l]} <span className="font-medium text-zinc-900 tabular-nums dark:text-zinc-100">{counts[l]}</span>
              </li>
            ))}
          </ul>
        </div>
      </Card>

      {fleet.error && <ErrorBox error={fleet.error} onRetry={fleet.reload} />}
      {fleet.loading && !fleet.data && <Spinner />}
      {fleet.data && tiles.length === 0 && (
        <Card>
          <Empty icon={<Network />} title="No minions yet">
            Accept a key on Enrollment and it shows up here.
          </Empty>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {groups.map((o) => (
          <section key={o.key} aria-label={`${GROUPINGS[outer]}: ${o.key}`} className={clsx('rounded-xl border border-zinc-200 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/40', o.count > 12 && 'md:col-span-2')}>
            <h2 className="mb-2 flex items-baseline justify-between gap-2 text-sm font-semibold">
              <span className="truncate font-mono" title={o.key}>
                {o.key}
              </span>
              <span className="shrink-0 text-xs font-normal text-zinc-500 dark:text-zinc-400">
                {o.count} {o.count === 1 ? 'minion' : 'minions'}
              </span>
            </h2>
            <LevelBar counts={levelCounts(shown, o.groups.flatMap((g) => g.tiles), state)} total={o.count} />
            <div className="space-y-2">
              {o.groups.map((i) => (
                <div key={i.key} className={clsx(i.key && 'rounded-lg border border-dashed border-zinc-300 p-2 dark:border-zinc-700')}>
                  {i.key && <h3 className="mb-1.5 text-xs font-medium text-zinc-600 dark:text-zinc-400">{i.key}</h3>}
                  <ul className="flex flex-wrap gap-1.5">
                    {i.tiles.map((t) => {
                      const l = levelOf(shown, t, state)
                      return (
                        <li key={t.id}>
                          <Link
                            to={`/minions/${encodeURIComponent(t.id)}`}
                            title={`${t.id}: ${l.label}`}
                            aria-label={`${t.id}: ${l.label}`}
                            className={clsx('flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-xs text-zinc-900 shadow-xs transition hover:-translate-y-px hover:shadow-sm dark:text-zinc-100', LEVEL_STYLE[l.level].tile)}
                          >
                            {LEVEL_STYLE[l.level].icon}
                            {t.id}
                          </Link>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </>
  )
}
