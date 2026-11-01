import { ArrowLeft, Cpu, HardDrive, Network, Play, Search, Terminal } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { Grains } from '../api/types'
import { JsonView } from '../components/JsonView'
import { Badge, Button, Card, CardHeader, ErrorBox, Input, Spinner, StatusDot, Tabs } from '../components/ui'
import { useAsync } from '../lib/hooks'
import { useSalt } from '../lib/session'
import { fmtMem, OsIcon } from './Minions'

export function MinionDetailPage() {
  const { id = '' } = useParams()
  const salt = useSalt()
  const navigate = useNavigate()
  const [tab, setTab] = useState<'grains' | 'pillar'>('grains')
  const [filter, setFilter] = useState('')

  const grains = useAsync(async () => {
    const [g, status] = await Promise.all([salt.grains(id, 'list'), salt.status()])
    return { grains: g[id] as Grains | undefined, up: status.up.includes(id) }
  }, [salt, id])
  const pillar = useAsync(() => (tab === 'pillar' ? salt.pillar(id) : Promise.resolve(undefined)), [salt, id, tab])

  const g = grains.data?.grains
  const filtered = (obj: Record<string, unknown> | undefined) =>
    obj && filter ? Object.fromEntries(Object.entries(obj).filter(([k, v]) => k.includes(filter) || JSON.stringify(v).includes(filter))) : obj

  const run = (fun: string, args = '') => navigate(`/run?tgt=${encodeURIComponent(id)}&tgt_type=list&fun=${encodeURIComponent(fun)}&args=${encodeURIComponent(args)}`)

  return (
    <>
      <Link to="/" className="mb-4 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
        <ArrowLeft className="size-4" /> Minions
      </Link>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <StatusDot up={grains.data?.up} />
          <div>
            <h1 className="font-mono text-xl font-semibold tracking-tight">{id}</h1>
            <p className="text-sm text-zinc-500">{g?.fqdn as string | undefined}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button icon={<Play className="size-4" />} onClick={() => run('test.ping')}>
            Ping
          </Button>
          <Button icon={<Play className="size-4" />} onClick={() => run('state.apply', 'test=True')}>
            Dry-run highstate
          </Button>
          <Button variant="primary" icon={<Terminal className="size-4" />} onClick={() => run('cmd.run', "'uptime'")}>
            Run command
          </Button>
        </div>
      </div>

      {grains.error && <ErrorBox error={grains.error} onRetry={grains.reload} />}
      {grains.loading && !grains.data && <Spinner />}
      {grains.data && !g && (
        <Card className="mb-6 p-4 text-sm text-zinc-500">This minion did not return grains — it is probably offline. Its key is still accepted.</Card>
      )}

      {g && (
        <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Fact icon={<OsIcon os={g.os} />} label="Operating system" value={`${g.os} ${g.osrelease}`} sub={`${g.kernel} ${g.kernelrelease}`} />
          <Fact icon={<Cpu className="size-4 text-zinc-400" />} label="Hardware" value={`${g.num_cpus} vCPU · ${fmtMem(g.mem_total)}`} sub={`${g.cpu_model ?? ''}`} />
          <Fact icon={<Network className="size-4 text-zinc-400" />} label="Addresses" value={g.ipv4?.filter((ip) => ip !== '127.0.0.1').join(', ') || '—'} sub={`virtual: ${g.virtual ?? '—'}`} />
          <Fact
            icon={<HardDrive className="size-4 text-zinc-400" />}
            label="Salt"
            value={g.saltversion ?? '—'}
            sub={
              <span className="flex flex-wrap gap-1">
                {(Array.isArray(g.roles) ? g.roles : []).map((r) => (
                  <Badge key={r}>{r}</Badge>
                ))}
              </span>
            }
          />
        </div>
      )}

      <Card>
        <CardHeader
          title={
            <Tabs
              value={tab}
              onChange={setTab}
              items={[
                { value: 'grains', label: 'Grains' },
                { value: 'pillar', label: 'Pillar' },
              ]}
            />
          }
          actions={
            <div className="relative">
              <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-zinc-400" />
              <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter keys…" className="w-56 pl-9" />
            </div>
          }
        />
        <div className="p-4 pl-8">
          {tab === 'grains' && g && <JsonView value={filtered(g)} openDepth={1} />}
          {tab === 'pillar' && (
            <>
              {pillar.error && <ErrorBox error={pillar.error} onRetry={pillar.reload} />}
              {pillar.loading && <Spinner label="Compiling pillar…" />}
              {pillar.data && !pillar.loading && <JsonView value={filtered(pillar.data)} openDepth={3} />}
            </>
          )}
        </div>
      </Card>
    </>
  )
}

function Fact({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub?: React.ReactNode }) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-xs font-medium text-zinc-500">
        {icon}
        {label}
      </div>
      <p className="mt-2 truncate font-medium" title={value}>
        {value}
      </p>
      {sub && <div className="mt-0.5 truncate text-xs text-zinc-500">{sub}</div>}
    </Card>
  )
}
