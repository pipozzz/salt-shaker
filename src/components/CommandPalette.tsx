import clsx from 'clsx'
import { Bookmark, CornerDownLeft, FileCode2, Hash, History, Search, Server, Terminal, type LucideIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { storage } from '../lib/storage'
import { useSalt } from '../lib/session'

interface Item {
  id: string
  group: string
  label: string
  hint?: string
  icon: LucideIcon
  run: () => void
}

export interface NavEntry {
  to: string
  label: string
  icon: LucideIcon
}

/** ⌘K / Ctrl+K launcher: pages, minions, saved targets, recent commands, jobs by jid. */
export function CommandPalette({ open, onClose, pages }: { open: boolean; onClose: () => void; pages: NavEntry[] }) {
  const salt = useSalt()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [minions, setMinions] = useState<string[]>([])
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActive(0)
    salt
      .keys()
      .then((k) => setMinions([...k.minions].sort()))
      .catch(() => undefined)
  }, [open, salt])

  const items = useMemo(() => {
    const go = (to: string) => () => {
      navigate(to)
      onClose()
    }
    const q = query.trim().toLowerCase()
    const fuzzy = (text: string) => !q || q.split(/\s+/).every((part) => text.toLowerCase().includes(part))
    const out: Item[] = []

    for (const p of pages) if (fuzzy(`${p.label} page`)) out.push({ id: `page:${p.to}`, group: 'Pages', label: p.label, icon: p.icon, run: go(p.to) })

    const saved = storage.get<Array<{ name: string; tgt: string; tgtType: string }>>('salt-shaker.targets') ?? []
    for (const s of saved) {
      if (fuzzy(`${s.name} ${s.tgt}`)) {
        out.push({ id: `target:${s.name}`, group: 'Saved targets', label: s.name, hint: `${s.tgtType}: ${s.tgt}`, icon: Bookmark, run: go(`/run?tgt=${encodeURIComponent(s.tgt)}&tgt_type=${s.tgtType}`) })
      }
    }

    for (const m of minions.filter((m) => fuzzy(m)).slice(0, q ? 8 : 5)) {
      out.push({ id: `minion:${m}`, group: 'Minions', label: m, icon: Server, run: go(`/minions/${encodeURIComponent(m)}`) })
    }

    const history = storage.get<Array<{ tgt: string; tgt_type: string; fun: string; args: string }>>('salt-shaker.run.history') ?? []
    for (const [i, h] of history.entries()) {
      if (fuzzy(`${h.fun} ${h.args} ${h.tgt}`) && out.filter((x) => x.group === 'Recent commands').length < 5) {
        out.push({
          id: `hist:${i}`,
          group: 'Recent commands',
          label: `${h.fun} ${h.args}`.trim(),
          hint: h.tgt,
          icon: History,
          run: go(`/run?tgt=${encodeURIComponent(h.tgt)}&tgt_type=${h.tgt_type}&fun=${encodeURIComponent(h.fun)}&args=${encodeURIComponent(h.args)}`),
        })
      }
    }

    if (/^\d{20}$/.test(q)) out.unshift({ id: 'jid', group: 'Jobs', label: `Open job ${q}`, icon: Hash, run: go(`/jobs/${q}`) })
    // "mod.fun" typed: offer to run it
    if (/^[a-z_]+\.[a-z_]+/i.test(q)) {
      const [fun, ...rest] = query.trim().split(/\s+/)
      out.push({ id: 'run', group: 'Actions', label: `Run ${query.trim()}`, hint: 'on *', icon: Terminal, run: go(`/run?fun=${encodeURIComponent(fun)}&args=${encodeURIComponent(rest.join(' '))}`) })
    }
    if (q && /\.sls$|^\w+\//.test(q)) out.push({ id: 'file', group: 'Actions', label: `Browse states for “${query.trim()}”`, icon: FileCode2, run: go('/files') })
    return out
  }, [query, minions, pages, navigate, onClose])

  useEffect(() => setActive(0), [query])
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (!open) return null

  let lastGroup = ''
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-zinc-950/40 p-4 pt-[12vh] backdrop-blur-sm" onMouseDown={onClose}>
      <div className="w-full max-w-xl overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-900" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-zinc-200 px-4 dark:border-zinc-800">
          <Search className="size-4 text-zinc-400" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((a) => Math.min(a + 1, items.length - 1))
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((a) => Math.max(a - 1, 0))
              }
              if (e.key === 'Enter') items[active]?.run()
            }}
            placeholder="Jump to a page or minion, paste a jid, or type a function like cmd.run…"
            className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-zinc-400"
          />
          <kbd className="rounded border border-zinc-200 px-1.5 text-[10px] text-zinc-400 dark:border-zinc-700">esc</kbd>
        </div>
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto p-2">
          {items.length === 0 && <p className="px-3 py-6 text-center text-sm text-zinc-500">No results</p>}
          {items.map((it, i) => {
            const header = it.group !== lastGroup ? it.group : null
            lastGroup = it.group
            const Icon = it.icon
            return (
              <div key={it.id}>
                {header && <p className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-zinc-400 uppercase">{header}</p>}
                <button
                  data-index={i}
                  onMouseMove={() => setActive(i)}
                  onClick={it.run}
                  className={clsx('flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm', i === active ? 'bg-accent-50 text-accent-700 dark:bg-accent-700/20 dark:text-accent-400' : 'text-zinc-700 dark:text-zinc-300')}
                >
                  <Icon className="size-4 shrink-0 opacity-70" />
                  <span className={clsx('truncate', it.group === 'Minions' || it.group === 'Recent commands' ? 'font-mono' : 'font-medium')}>{it.label}</span>
                  {it.hint && <span className="truncate font-mono text-xs text-zinc-400">{it.hint}</span>}
                  {i === active && <CornerDownLeft className="ml-auto size-3.5 shrink-0 opacity-60" />}
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
