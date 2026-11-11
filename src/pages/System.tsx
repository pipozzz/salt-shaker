import { PeersSettings } from '../components/Instances'
import clsx from 'clsx'
import { RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { demoSystem } from '../api/demo-admin'
import { system, type SystemStatus } from '../api/server'
import { useSession } from '../lib/session'
import { Badge, Button, Card, CardHeader, ErrorBox, PageHeader, Spinner, type Tone } from '../components/ui'
import { useAsync } from '../lib/hooks'
import { relTime } from '../lib/format'

/** For admins: one place to see whether salt-api, the event bus, the database and notifications work. */
export function SystemPage() {
  const { session } = useSession()
  const { data, error, loading, reload } = useAsync(session?.mode === 'demo' ? demoSystem : system, [])
  return (
    <>
      <PageHeader
        title="System"
        description="Whether this Salt Shaker can reach the master and keep up with it."
        actions={
          <Button icon={<RefreshCw className={clsx('size-4', loading && 'animate-spin')} />} onClick={reload} disabled={loading}>
            Check again
          </Button>
        }
      />
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && loading && <Spinner label="Checking salt-api…" />}
      {data && (
        <div className="grid gap-4 lg:grid-cols-2">
          <SaltApi s={data} />
          <EventBus s={data} />
          <Database s={data} />
          <Automation s={data} />
          <Settings s={data} />
          <PeersSettings />
        </div>
      )}
    </>
  )
}

function Section({ title, status, children, className }: { title: string; status?: { tone: Tone; label: string }; children: ReactNode; className?: string }) {
  return (
    <Card className={className}>
      <CardHeader title={title} actions={status && <Badge tone={status.tone}>{status.label}</Badge>} />
      <dl className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-2 p-4 text-sm">{children}</dl>
    </Card>
  )
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-zinc-500 dark:text-zinc-400">{k}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  )
}

const when = (iso: string | null) => (iso ? <span title={new Date(iso).toLocaleString()}>{relTime(new Date(iso))}</span> : '—')

function SaltApi({ s }: { s: SystemStatus }) {
  const a = s.saltApi
  return (
    <Section title="salt-api" status={a.ok ? { tone: 'green', label: 'Connected' } : { tone: 'red', label: 'Not working' }}>
      <Row k="URL">
        <span className="font-mono text-xs">{a.url}</span>
      </Row>
      <Row k="Service account">
        <span className="font-mono text-xs">{a.username}</span> <span className="text-zinc-500 dark:text-zinc-400">({a.eauth})</span>
      </Row>
      {a.ok && a.keys ? (
        <>
          <Row k="Answered in">{a.ms} ms</Row>
          <Row k="Minion keys">
            {a.keys.accepted} accepted
            {a.keys.pending > 0 && (
              <>
                {' · '}
                <Link to="/keys" className="text-accent-700 underline underline-offset-2 hover:text-accent-800 dark:text-accent-400 dark:hover:text-accent-100">
                  {a.keys.pending} pending
                </Link>
              </>
            )}
          </Row>
        </>
      ) : (
        <Row k="Error">
          <span className="text-red-700 dark:text-red-400">{a.error}</span>
        </Row>
      )}
    </Section>
  )
}

const STREAM: Record<'stopped' | 'connecting' | 'connected', { tone: Tone; label: string }> = {
  connected: { tone: 'green', label: 'Following' },
  connecting: { tone: 'amber', label: 'Reconnecting' },
  stopped: { tone: 'zinc', label: 'Stopped' },
}

function EventBus({ s }: { s: SystemStatus }) {
  const e = s.events
  const stale = !e.thisInstance && e.leaderStale?.stale
  const status = e.stream
    ? STREAM[e.stream.state]
    : stale
      ? { tone: 'amber' as const, label: 'Holder stopped' }
      : e.leader
        ? { tone: 'green' as const, label: 'Another instance' }
        : { tone: 'red' as const, label: 'Nobody' }
  return (
    <Section title="Event bus" status={status}>
      <Row k="Followed by">
        {e.leader ? (
          <>
            <span className="font-mono text-xs">{e.leader}</span>
            {e.thisInstance && <span className="text-zinc-500 dark:text-zinc-400"> (this instance)</span>}
          </>
        ) : (
          <span className="text-red-700 dark:text-red-400">no instance; job history and alerts are paused</span>
        )}
      </Row>
      {e.stream ? (
        <>
          <Row k={e.stream.state === 'connected' ? 'Connected' : 'Since'}>{when(e.stream.since)}</Row>
          <Row k="Last event">{e.stream.lastEventAt ? when(e.stream.lastEventAt) : 'none yet'}</Row>
          {e.stream.lastError && (
            <Row k="Last error">
              <span className="text-red-700 dark:text-red-400">{e.stream.lastError}</span>
            </Row>
          )}
        </>
      ) : (
        e.leader &&
        (stale && e.leaderStale ? (
          <Row k="Details">
            <span className="text-amber-700 dark:text-amber-400">
              it last renewed its lease {relTime(new Date(e.leaderStale.renewedAt))} and has probably stopped; another instance takes over within {e.leaderStale.expiresInSeconds} s
            </span>
          </Row>
        ) : (
          <Row k="Details">in that instance's log and on its System page</Row>
        ))
      )}
      {!e.thisInstance && (
        <Row k="This instance">
          <span className="font-mono text-xs">{s.instance}</span>
        </Row>
      )}
    </Section>
  )
}

const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`

function Database({ s }: { s: SystemStatus }) {
  const d = s.database
  return (
    <Section title="Database">
      <Row k="Engine">{d.dialect === 'pg' ? 'PostgreSQL' : 'SQLite'}</Row>
      <Row k="Jobs recorded">{d.jobs.toLocaleString()}</Row>
      <Row k="Oldest job">{when(d.oldestJob)}</Row>
      <Row k="Jobs kept for">{days(d.retentionDays)}</Row>
      <Row k="Audit log kept">{d.auditRetentionDays > 0 ? `for ${days(d.auditRetentionDays)}` : 'forever (AUDIT_RETENTION_DAYS not set)'}</Row>
    </Section>
  )
}

function Automation({ s }: { s: SystemStatus }) {
  const n = s.notifications
  const status = n.failing.length ? { tone: 'red' as const, label: `${n.failing.length} failing` } : undefined
  return (
    <Section title="Schedules & notifications" status={status}>
      <Row k="Schedules">
        <Link to="/schedules" className="text-accent-700 underline underline-offset-2 hover:text-accent-800 dark:text-accent-400 dark:hover:text-accent-100">
          {s.schedules.enabled} of {s.schedules.total} enabled
        </Link>
      </Row>
      <Row k="Channels">
        <Link to="/notifications" className="text-accent-700 underline underline-offset-2 hover:text-accent-800 dark:text-accent-400 dark:hover:text-accent-100">
          {n.enabled} of {n.channels} enabled
        </Link>
      </Row>
      {n.failing.map((f) => (
        <Row key={f.name} k={f.name}>
          <span className="text-red-700 dark:text-red-400">{f.error}</span>
        </Row>
      ))}
      <Row k="Minions down alert">{s.settings.presenceMinutes > 0 ? `checks every ${s.settings.presenceMinutes} min` : 'off (PRESENCE_CHECK_MINUTES=0)'}</Row>
    </Section>
  )
}

function Settings({ s }: { s: SystemStatus }) {
  const t = s.settings
  return (
    <Section title="Settings" className="lg:col-span-2">
      <Row k="Version">{s.version}</Row>
      <Row k="Running since">{when(s.startedAt)}</Row>
      <Row k="Public URL">
        <span className="font-mono text-xs">{t.publicUrl}</span>
        {![t.publicUrl, ...t.trustedOrigins].includes(window.location.origin) && (
          <span className="text-amber-700 dark:text-amber-400"> — you opened {window.location.origin}; sign-in cookies and SSO redirects use the public URL, so set PUBLIC_URL to the address people use</span>
        )}
      </Row>
      <Row k="Single sign-on">
        {t.sso ? (
          <>
            {t.sso.name} {t.sso.active ? <Badge tone="green">active</Badge> : <Badge tone="red">provider unreachable</Badge>}
          </>
        ) : (
          'off'
        )}
      </Row>
      <Row k="Password sign-in">{t.passwordLogin === 'admins' ? 'admins only' : 'everyone'}</Row>
      <Row k="Time zone">{s.timeZone} (for schedules)</Row>
      <Row k="Prometheus /metrics">{t.metrics ? 'on' : 'off (METRICS_TOKEN not set)'}</Row>
      <Row k="Behind a proxy">{t.trustProxy ? 'yes, client IPs from X-Forwarded-For' : 'no (TRUST_PROXY not set)'}</Row>
    </Section>
  )
}
