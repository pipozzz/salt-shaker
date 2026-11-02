import clsx from 'clsx'
import { ChevronRight } from 'lucide-react'
import { useState } from 'react'

/** Collapsible, YAML-flavoured tree for arbitrary Salt return data. */
export function JsonView({ value, depth = 0, openDepth = 2 }: { value: unknown; depth?: number; openDepth?: number }) {
  if (value === null || typeof value !== 'object') return <Scalar value={value} />
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value)
  if (entries.length === 0) return <span className="text-zinc-500 dark:text-zinc-400">{Array.isArray(value) ? '[]' : '{}'}</span>
  return (
    <div className={clsx('font-mono text-[12.5px] leading-6', depth > 0 && 'border-l border-zinc-200 pl-3 dark:border-zinc-800')}>
      {entries.map(([k, v]) => (
        <Row key={k} name={k} value={v} isIndex={Array.isArray(value)} depth={depth} openDepth={openDepth} />
      ))}
    </div>
  )
}

function Row({ name, value, isIndex, depth, openDepth }: { name: string; value: unknown; isIndex: boolean; depth: number; openDepth: number }) {
  const nested = value !== null && typeof value === 'object' && Object.keys(value).length > 0
  const [open, setOpen] = useState(depth < openDepth)
  const label = isIndex ? <span className="text-zinc-500 dark:text-zinc-400">-</span> : <span className="text-sky-700 dark:text-sky-400">{name}:</span>
  if (!nested) {
    const multiline = typeof value === 'string' && value.includes('\n')
    return (
      <div className={clsx(multiline ? 'block' : 'flex gap-2')}>
        {label}
        {multiline ? <pre className="ml-3 whitespace-pre-wrap text-zinc-700 dark:text-zinc-300">{value as string}</pre> : <Scalar value={value} />}
      </div>
    )
  }
  const size = Object.keys(value as object).length
  return (
    <div>
      <button onClick={() => setOpen(!open)} className="-ml-4 flex items-center gap-0.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800/60">
        <ChevronRight className={clsx('size-3.5 text-zinc-500 transition-transform dark:text-zinc-400', open && 'rotate-90')} />
        {label}
        {!open && <span className="ml-1 text-zinc-500 dark:text-zinc-400">{Array.isArray(value) ? `[${size}]` : `{${size}}`}</span>}
      </button>
      {open && <JsonView value={value} depth={depth + 1} openDepth={openDepth} />}
    </div>
  )
}

function Scalar({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-zinc-500 dark:text-zinc-400">null</span>
  if (typeof value === 'boolean') return <span className={value ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>{String(value)}</span>
  if (typeof value === 'number') return <span className="text-violet-600 dark:text-violet-400">{value}</span>
  if (typeof value === 'string' && value === '') return <span className="text-zinc-500 dark:text-zinc-400">""</span>
  if (Array.isArray(value)) return <span className="text-zinc-500 dark:text-zinc-400">[]</span>
  if (typeof value === 'object') return <span className="text-zinc-500 dark:text-zinc-400">{'{}'}</span>
  return <span className="break-all text-zinc-800 dark:text-zinc-200">{String(value)}</span>
}
