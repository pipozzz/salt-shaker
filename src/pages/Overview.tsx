import clsx from 'clsx'
import { ArrowRight, CircleAlert, History, Info, Package, RefreshCw, Server, ShieldAlert, ShieldCheck, TriangleAlert } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { demoOverview } from '../api/demo-overview'
import { history } from '../api/server'
import { VulnTrend } from '../components/VulnTrend'
import { Button, Card, CardHeader, Empty, PageHeader, Spinner, Stat, type Tone } from '../components/ui'
import { relTime } from '../lib/format'
import { useAsync } from '../lib/hooks'
import { overview, type AttentionItem, type AttentionLevel } from '../lib/overview'
import { useSalt, useSession } from '../lib/session'
import { useVulnApi } from '../lib/vulnapi'

/** How the fleet is doing, and what needs someone's attention, worst first. */
export function OverviewPage() {
  const salt = useSalt()
  const { session } = useSession()
  const vulnApi = useVulnApi()
  const mode = session?.mode
  // compliance, patches and job history are recorded by the server (the demo has its own)
  const recorded = mode === 'server' ? history : mode === 'demo' ? demoOverview : null
  const [refreshes, setRefreshes] = useState(0)
  // "now" for what counts as recent: when the page was loaded or refreshed
  const [now, setNow] = useState(() => Date.now())
  const keys = useAsync(() => salt.keys(), [salt, refreshes])
  // manage.status waits for the slow minions; everything else shows meanwhile
  const status = useAsync(() => salt.status(), [salt, refreshes])
  const compliance = useAsync(() => (recorded ? (mode === 'demo' ? demoOverview.compliance() : history.minionCompliance()).then((r) => r.minions).catch(() => null) : Promise.resolve(null)), [mode, refreshes])
  const updates = useAsync(() => (recorded ? (mode === 'demo' ? demoOverview.updates() : history.minionUpdates()).then((r) => r.minions).catch(() => null) : Promise.resolve(null)), [mode, refreshes])
  const failed = useAsync(
    () => (mode === 'demo' ? demoOverview.failedJobs() : mode === 'server' ? history.jobs({ result: 'failed', limit: 100 }) : Promise.resolve(null)).then((r) => r?.rows ?? null).catch(() => null),
    [mode, refreshes],
  )
  // the vulnerability report is the server's (or the demo's); live mode has none
  const vulns = useAsync(() => (mode === 'live' ? Promise.resolve(null) : vulnApi.report().catch(() => null)), [vulnApi, mode, refreshes])
  const trend = useAsync(() => (mode === 'live' ? Promise.resolve(null) : vulnApi.trend(90).catch(() => null)), [vulnApi, mode, refreshes])

  const o = overview({
    now,
    keys: keys.data ?? null,
    status: status.data ?? null,
    compliance: compliance.data ?? null,
    updates: updates.data ?? null,
    vulns: vulns.data ?? null,
    failedJobs: failed.data ?? null,
  })
  const loading = keys.loading || compliance.loading || updates.loading || failed.loading || vulns.loading
  const minionsDown = o.minions.down ?? 0

  return (
    <>
      <PageHeader
        title="Overview"
        description="How the fleet is doing, and what needs attention."
        actions={
          <Button icon={<RefreshCw className={clsx('size-4', loading && 'animate-spin')} />} onClick={() => {
              setNow(Date.now())
              setRefreshes((n) => n + 1)
            }} disabled={loading}>
            Refresh
          </Button>
        }
      />

      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <Tile to={minionsDown ? '/minions?status=down' : '/minions'}>
          <Stat
            label="Minions responding"
            value={keys.data ? `${o.minions.up ?? '…'}/${o.minions.accepted}` : '…'}
            icon={<Server />}
            tone={minionsDown ? 'red' : o.minions.up === null ? 'zinc' : 'green'}
            hint={o.minions.up === null ? 'Asking the minions…' : [minionsDown ? `${minionsDown} not responding` : 'all answering', o.minions.pending ? `${o.minions.pending} waiting for approval` : null].filter(Boolean).join(' · ')}
          />
        </Tile>
        {recorded && (
          <Tile to="/compliance">
            <Stat
              label="Drifted or failing"
              value={o.compliance ? o.compliance.drift + o.compliance.error : '…'}
              icon={<ShieldCheck />}
              tone={!o.compliance ? 'zinc' : o.compliance.error ? 'red' : o.compliance.drift ? 'amber' : 'green'}
              hint={o.compliance ? (o.compliance.checkedAt ? `of ${o.compliance.checked} checked · ${relTime(new Date(o.compliance.checkedAt))}` : 'no check yet') : null}
            />
          </Tile>
        )}
        {recorded && (
          <Tile to="/patches">
            <Stat
              label="Minions to patch"
              value={o.patches ? o.patches.needing : '…'}
              icon={<Package />}
              tone={!o.patches ? 'zinc' : o.patches.needing ? 'amber' : 'green'}
              hint={o.patches ? (o.patches.checkedAt ? `${o.patches.packages} upgrades · scanned ${relTime(new Date(o.patches.checkedAt))}` : 'no patch scan yet') : null}
            />
          </Tile>
        )}
        {mode !== 'live' && (
          <Tile to="/vulnerabilities">
            <Stat
              label="Critical & high vulns"
              value={o.vulns ? o.vulns.critical + o.vulns.high : vulns.loading ? '…' : '—'}
              icon={<ShieldAlert />}
              tone={!o.vulns ? 'zinc' : o.vulns.critical ? 'red' : o.vulns.high ? 'amber' : 'green'}
              hint={o.vulns ? `${o.vulns.fixable} with a fix · ${o.vulns.affected}/${o.vulns.scanned} minions` : vulns.loading ? null : 'no vulnerability scan yet'}
            />
          </Tile>
        )}
        {recorded && (
          <Tile to="/jobs?result=failed">
            <Stat label="Failed jobs, last day" value={o.jobs ? o.jobs.failed : '…'} icon={<History />} tone={!o.jobs ? 'zinc' : o.jobs.failed ? 'amber' : 'green'} hint={o.jobs ? (o.jobs.failed ? 'see which minions failed' : 'nothing failed') : null} />
          </Tile>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card className="self-start">
          <CardHeader title="Needs attention" subtitle="Worst first; each opens the page where it gets fixed." />
          {!keys.data && keys.loading ? (
            <Spinner />
          ) : o.attention.length === 0 ? (
            <Empty icon={<ShieldCheck />} title="All clear">
              {loading ? 'Still checking a few things…' : 'Nothing is down, drifted, failing or waiting for a fix.'}
            </Empty>
          ) : (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
              {o.attention.map((a) => (
                <AttentionRow key={a.id} item={a} />
              ))}
            </ul>
          )}
          {mode === 'live' && (
            <p className="border-t border-zinc-100 px-4 py-2 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">Compliance, patches, vulnerabilities and failed jobs are recorded by the server; without it, the overview shows minions and keys only.</p>
          )}
        </Card>

        {mode !== 'live' && (
          <Card className="self-start">
            <CardHeader title="Vulnerabilities, last 90 days" subtitle="Distinct vulnerabilities each day, accepted ones left out" />
            <div className="p-4">
              {(trend.data?.days.length ?? 0) >= 2 ? (
                <VulnTrend days={trend.data!.days} />
              ) : (
                <p className="text-sm text-zinc-500 dark:text-zinc-400">{trend.loading ? 'Loading…' : 'The trend starts once there are two days of vulnerability scans.'}</p>
              )}
            </div>
          </Card>
        )}
      </div>
    </>
  )
}

/** A stat that opens the page behind it. */
function Tile({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="block h-full rounded-xl transition hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500">
      {children}
    </Link>
  )
}

const LEVEL: Record<AttentionLevel, { icon: ReactNode; tone: Tone; label: string }> = {
  critical: { icon: <CircleAlert className="size-4 text-red-600 dark:text-red-400" />, tone: 'red', label: 'Critical' },
  warning: { icon: <TriangleAlert className="size-4 text-amber-600 dark:text-amber-400" />, tone: 'amber', label: 'Warning' },
  info: { icon: <Info className="size-4 text-sky-600 dark:text-sky-400" />, tone: 'blue', label: 'Info' },
}

function AttentionRow({ item }: { item: AttentionItem }) {
  const l = LEVEL[item.level]
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <span className="mt-0.5 shrink-0" role="img" aria-label={l.label}>
        {l.icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{item.title}</p>
        {item.detail && <p className="mt-0.5 truncate font-mono text-xs text-zinc-500 dark:text-zinc-400" title={item.detail}>{item.detail}</p>}
      </div>
      <Link
        to={item.to}
        className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-accent-700 ring-1 ring-zinc-200 ring-inset hover:bg-zinc-50 dark:text-accent-400 dark:ring-zinc-700 dark:hover:bg-zinc-800"
      >
        {item.action} <ArrowRight className="size-3.5" />
      </Link>
    </li>
  )
}
