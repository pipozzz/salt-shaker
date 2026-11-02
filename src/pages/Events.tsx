import clsx from 'clsx'
import { Activity, ChevronRight, Eraser, Pause, Play, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { SaltEvent } from '../api/types'
import { JsonView } from '../components/JsonView'
import { Badge, Button, Card, Empty, Input, PageHeader, StatusDot, type Tone } from '../components/ui'
import { useSession } from '../lib/session'

const CATEGORIES: Array<{ key: string; label: string; match: RegExp; tone: Tone }> = [
  { key: 'job', label: 'Jobs', match: /^salt\/job\//, tone: 'blue' },
  { key: 'auth', label: 'Keys & auth', match: /^salt\/(auth|key)|^minion_start|^salt\/minion\/.*\/start/, tone: 'amber' },
  { key: 'beacon', label: 'Beacons', match: /^salt\/beacon\//, tone: 'accent' },
  { key: 'other', label: 'Other', match: /.*/, tone: 'zinc' },
]

const categorize = (tag: string) => CATEGORIES.find((c) => c.match.test(tag))!

export function EventsPage() {
  const { events, eventsConnected, clearEvents } = useSession()
  const [paused, setPaused] = useState<SaltEvent[] | null>(null)
  const [query, setQuery] = useState('')
  const [hidden, setHidden] = useState<Set<string>>(new Set(['other']))

  const list = useMemo(
    () => (paused ?? events).filter((e) => !hidden.has(categorize(e.tag).key)).filter((e) => !query || e.tag.includes(query) || JSON.stringify(e.data).includes(query)),
    [events, paused, query, hidden],
  )

  return (
    <>
      <PageHeader
        title="Events"
        description={
          <span className="flex items-center gap-2">
            <StatusDot up={eventsConnected} /> {eventsConnected ? 'Live stream from the master event bus' : 'Reconnecting to the event stream…'}
          </span>
        }
        actions={
          <>
            <Button icon={paused ? <Play className="size-4" /> : <Pause className="size-4" />} onClick={() => setPaused(paused ? null : events)}>
              {paused ? 'Resume' : 'Pause'}
            </Button>
            <Button icon={<Eraser className="size-4" />} onClick={clearEvents}>
              Clear
            </Button>
          </>
        }
      />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-zinc-200 p-3 dark:border-zinc-800">
          <div className="relative min-w-48 flex-1">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-zinc-500 dark:text-zinc-400" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter by tag or payload…" className="pl-9 font-mono" />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {CATEGORIES.map((c) => (
              <button
                key={c.key}
                onClick={() => setHidden((h) => {
                  const n = new Set(h)
                  if (n.has(c.key)) n.delete(c.key)
                  else n.add(c.key)
                  return n
                })}
                className={clsx('rounded-full border px-2.5 py-1 text-xs font-medium transition', hidden.has(c.key) ? 'border-zinc-200 text-zinc-500 line-through dark:border-zinc-800 dark:text-zinc-400' : 'border-zinc-300 text-zinc-700 dark:border-zinc-700 dark:text-zinc-300')}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>
        {list.length === 0 ? (
          <Empty icon={<Activity />} title="Waiting for events">
            Run something on the Run page and watch the job events arrive here.
          </Empty>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
            {list.slice(0, 200).map((e, i) => (
              <EventRow key={`${e.tag}-${String(e.data._stamp)}-${i}`} event={e} />
            ))}
          </ul>
        )}
      </Card>
    </>
  )
}

function EventRow({ event }: { event: SaltEvent }) {
  const [open, setOpen] = useState(false)
  const cat = categorize(event.tag)
  const stamp = typeof event.data._stamp === 'string' ? new Date(event.data._stamp.endsWith('Z') ? event.data._stamp : `${event.data._stamp}Z`) : null
  const { _stamp, _received, ...data } = event.data
  void _stamp
  void _received
  return (
    <li>
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/30">
        <ChevronRight className={clsx('size-3.5 shrink-0 text-zinc-500 transition-transform dark:text-zinc-400', open && 'rotate-90')} />
        <span className="w-16 shrink-0 font-mono text-xs text-zinc-500 tabular-nums dark:text-zinc-400">{stamp && !isNaN(+stamp) ? stamp.toLocaleTimeString() : ''}</span>
        <Badge tone={cat.tone} className="hidden shrink-0 sm:inline-flex">
          {cat.label}
        </Badge>
        <span className="truncate font-mono text-xs">{event.tag}</span>
        {'id' in data && <span className="ml-auto shrink-0 font-mono text-xs text-zinc-500 dark:text-zinc-400">{String(data.id)}</span>}
      </button>
      {open && (
        <div className="border-t border-zinc-100 bg-zinc-50/60 py-3 pr-4 pl-14 dark:border-zinc-800 dark:bg-zinc-950/40">
          <JsonView value={data} openDepth={2} />
        </div>
      )}
    </li>
  )
}
