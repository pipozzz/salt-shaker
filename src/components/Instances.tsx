import clsx from 'clsx'
import { ArrowUpRight, ChevronDown, Server, Trash2, Unplug } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import type { InstanceSummary } from '../api/server'
import { useAsync } from '../lib/hooks'
import { usePeersApi } from '../lib/peers'
import { useSession } from '../lib/session'
import { Badge, Button, Card, CardHeader, ErrorBox, Field, Input } from './ui'

/** In the sidebar: which instance (master) this is, and the others to switch to. Hidden with just one. */
export function InstanceSwitcher() {
  const api = usePeersApi()
  const { session } = useSession()
  const list = useAsync(() => (api ? api.list() : Promise.resolve(null)), [api])
  if (!list.data || list.data.peers.length === 0) return null
  const demo = session?.mode === 'demo'
  return (
    <details className="group relative mx-2 mt-1">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-800/60 [&::-webkit-details-marker]:hidden">
        <Server className="size-4 text-zinc-500" />
        <span className="sr-only">Instance: </span>
        <span className="truncate font-medium">{list.data.self.name}</span>
        <ChevronDown className="ml-auto size-4 text-zinc-500 transition group-open:rotate-180" />
      </summary>
      <ul className="absolute inset-x-0 z-30 mt-1 overflow-hidden rounded-lg border border-zinc-200 bg-white py-1 text-sm shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
        {list.data.peers.map((p) => (
          <li key={p.id}>
            <a
              href={demo ? undefined : p.url}
              aria-disabled={demo || undefined}
              title={demo ? 'In the demo, the other instances are made up' : p.url}
              className={clsx('flex items-center gap-2 px-3 py-1.5', demo ? 'cursor-not-allowed text-zinc-500' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800')}
            >
              <span className="truncate">{p.name}</span>
              <ArrowUpRight className="ml-auto size-3.5 shrink-0 text-zinc-400" />
            </a>
          </li>
        ))}
      </ul>
    </details>
  )
}

const num = (n: number | null | undefined, bad = false) => (n === null || n === undefined ? <span className="text-zinc-400">–</span> : <span className={clsx('tabular-nums', bad && n > 0 && 'font-semibold text-red-700 dark:text-red-400')}>{n}</span>)

/** On the overview: every instance (master) side by side, this one first. Hidden with just one. */
export function OtherMasters({ refreshes }: { refreshes: number }) {
  const api = usePeersApi()
  const self = useAsync(() => (api ? api.summary() : Promise.resolve(null)), [api, refreshes])
  const others = useAsync(() => (api ? api.status(refreshes > 0) : Promise.resolve(null)), [api, refreshes])
  if (!others.data || others.data.peers.length === 0) return null
  const rows: Array<{ key: string; name: string; url: string | null; me?: boolean; s?: InstanceSummary; error?: string }> = [
    ...(self.data ? [{ key: 'self', name: self.data.name, url: null, me: true, s: self.data }] : []),
    ...others.data.peers.map((p) => ({ key: String(p.id), name: p.name, url: p.url, s: p.summary, error: p.error })),
  ]
  return (
    <Card className="mb-6">
      <CardHeader title="All masters" subtitle="Each master has its own Salt Shaker; this is how they're all doing. Open one to see more." />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              <th className="py-2 pr-3 pl-4 font-medium">Instance</th>
              <th className="px-3 py-2 text-right font-medium">Minions</th>
              <th className="px-3 py-2 text-right font-medium">Not answering</th>
              <th className="px-3 py-2 text-right font-medium">Failed jobs (24 h)</th>
              <th className="px-3 py-2 text-right font-medium">Critical vulns</th>
              <th className="px-3 py-2 text-right font-medium">Pending keys</th>
              <th className="px-3 py-2 pr-4 text-right font-medium">Awaiting approval</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
            {rows.map((r) => (
              <tr key={r.key}>
                <td className="py-2 pr-3 pl-4 font-medium">
                  {r.url ? (
                    <a href={r.url} className="inline-flex items-center gap-1 hover:underline">
                      {r.name} <ArrowUpRight className="size-3.5 text-zinc-400" />
                    </a>
                  ) : (
                    <span className="inline-flex items-center gap-2">
                      {r.name} <Badge>this one</Badge>
                    </span>
                  )}
                </td>
                {r.s ? (
                  <>
                    <td className="px-3 py-2 text-right">{num(r.s.minions.accepted)}</td>
                    <td className="px-3 py-2 text-right">{num(r.s.minions.notAnswering, true)}</td>
                    <td className="px-3 py-2 text-right">{num(r.s.failedJobs, true)}</td>
                    <td className="px-3 py-2 text-right">{num(r.s.vulns?.critical, true)}</td>
                    <td className="px-3 py-2 text-right">{num(r.s.pendingKeys)}</td>
                    <td className="px-3 py-2 pr-4 text-right">{num(r.s.waitingApproval)}</td>
                  </>
                ) : (
                  <td colSpan={6} className="px-3 py-2 pr-4 text-right text-xs text-amber-700 dark:text-amber-400">
                    <span className="inline-flex items-center gap-1.5">
                      <Unplug className="size-3.5" /> {r.error}
                    </span>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

/** On System, for admins: the other instances, and adding one with a token made there. */
export function PeersSettings() {
  const api = usePeersApi()
  const [reloads, setReloads] = useState(0)
  const list = useAsync(() => (api ? api.list() : Promise.resolve(null)), [api, reloads])
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  if (!api) return null
  const add = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.add({ name, url, token })
      setName('')
      setUrl('')
      setToken('')
      setReloads((n) => n + 1)
    } catch (err) {
      setError(err as Error)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card className="lg:col-span-2">
      <CardHeader
        title="Other masters"
        subtitle={`This instance is "${list.data?.self.name ?? '…'}" (INSTANCE_NAME). Add the Salt Shaker of each other master with an API token made there, ideally a viewer's: the overview then shows them all, and the sidebar switches between them.`}
      />
      {list.data && list.data.peers.length > 0 && (
        <ul className="divide-y divide-zinc-100 border-b border-zinc-100 text-sm dark:divide-zinc-800/70 dark:border-zinc-800">
          {list.data.peers.map((p) => (
            <li key={p.id} className="flex items-center gap-3 px-4 py-2.5">
              <span className="font-medium">{p.name}</span>
              <span className="truncate font-mono text-xs text-zinc-500 dark:text-zinc-400">{p.url}</span>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                icon={<Trash2 className="size-3.5" />}
                aria-label={`Remove ${p.name}`}
                onClick={async () => {
                  await api.remove(p.id)
                  setReloads((n) => n + 1)
                }}
              />
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="flex flex-wrap items-end gap-3 p-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="prod-us" className="w-36" required aria-label="Instance name" />
        </Field>
        <Field label="Address">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://salt-us.example.com" className="w-72" required aria-label="Instance address" />
        </Field>
        <Field label="API token from there">
          <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="ss_…" className="w-56 font-mono" required autoComplete="off" aria-label="API token from there" />
        </Field>
        <Button type="submit" variant="primary" loading={busy} disabled={!name.trim() || !url.trim() || !token.trim()}>
          Add
        </Button>
      </form>
      {error && (
        <div className="px-4 pb-4">
          <ErrorBox error={error} />
        </div>
      )}
    </Card>
  )
}
