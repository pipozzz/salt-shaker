import clsx from 'clsx'
import { Bookmark, BookmarkCheck, Crosshair, Loader2, Lock, Share2, TriangleAlert, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { TargetType } from '../api/types'
import { useSalt, useSession } from '../lib/session'
import { useSavedTargets } from '../lib/targets'
import { Button, Field, Input, Select } from './ui'

const TARGET_HINTS: Record<TargetType, string> = {
  glob: 'web-*  ·  *',
  list: 'web-01,db-01',
  grain: 'os:Ubuntu  ·  roles:web',
  compound: 'G@os:Debian and web*',
  pcre: '^(web|db)-0[12]$',
  pillar: 'env:prod',
  nodegroup: 'webservers',
}

interface Preview {
  key: string
  minions?: string[]
  error?: boolean
}

/**
 * Target + match type inputs with a live preview of matched minions (from the master's
 * cache, so nothing runs) and named, saved targets (shared with the team when there's a server).
 */
export function TargetField({
  tgt,
  tgtType,
  onChange,
  onMatched,
}: {
  tgt: string
  tgtType: TargetType
  onChange: (tgt: string, tgtType: TargetType) => void
  onMatched?: (minions: string[] | null) => void
}) {
  const salt = useSalt()
  const { targets: saved, save: saveTarget, remove, canRemove, unshared, shareLocal } = useSavedTargets()
  const [naming, setNaming] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)

  // debounced "who would this hit?" lookup
  const key = `${tgtType}\u0000${tgt.trim()}`
  useEffect(() => {
    if (!tgt.trim()) return
    let alive = true
    const t = setTimeout(() => {
      salt
        .matchTarget(tgt.trim(), tgtType)
        .then((minions) => alive && setPreview({ key, minions }))
        .catch(() => alive && setPreview({ key, error: true }))
    }, 400)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [salt, tgt, tgtType, key])
  const current = tgt.trim() && preview?.key === key ? preview : null

  useEffect(() => {
    onMatched?.(current?.minions ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current])

  const isSaved = saved.find((s) => s.tgt === tgt.trim() && s.tgtType === tgtType)
  const run = (p: Promise<unknown>, done?: () => void) => {
    setSaveError(null)
    p.then(done, (e: unknown) => setSaveError(e instanceof Error ? e.message : String(e)))
  }
  const save = () => {
    if (!name.trim()) return
    run(saveTarget(name.trim(), tgt.trim(), tgtType), () => {
      setNaming(false)
      setName('')
    })
  }

  return (
    <div className="space-y-2">
      <ScopeNote />
      <div className="grid gap-4 sm:grid-cols-[1fr_160px]">
        <Field label="Target" hint={<TargetPreview hint={TARGET_HINTS[tgtType]} preview={current} />}>
          <div className="relative">
            <Input value={tgt} onChange={(e) => onChange(e.target.value, tgtType)} className="pr-9 font-mono" required />
            <button
              type="button"
              title={isSaved ? `Saved as “${isSaved.name}”` : 'Save this target'}
              onClick={(e) => {
                e.preventDefault()
                if (!isSaved && tgt.trim()) setNaming(!naming)
              }}
              className={clsx('absolute top-1.5 right-1.5 rounded-md p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800', isSaved ? 'text-accent-700 dark:text-accent-400' : 'text-zinc-500')}
            >
              {isSaved ? <BookmarkCheck className="size-4" /> : <Bookmark className="size-4" />}
            </button>
          </div>
        </Field>
        <Field label="Match by">
          <Select value={tgtType} onChange={(e) => onChange(tgt, e.target.value as TargetType)}>
            {Object.keys(TARGET_HINTS).map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {naming && (
        <div className="flex items-center gap-2">
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                save()
              }
              if (e.key === 'Escape') setNaming(false)
            }}
            placeholder="Name, e.g. webservers"
            className="h-8 max-w-60"
          />
          <Button type="button" size="sm" variant="primary" onClick={save} disabled={!name.trim()}>
            Save target
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setNaming(false)}>
            Cancel
          </Button>
        </div>
      )}

      {saveError && <p className="text-xs text-red-600 dark:text-red-400">{saveError}</p>}

      {saved.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-zinc-500 dark:text-zinc-400">Saved:</span>
          {saved.map((s) => {
            const active = s.tgt === tgt.trim() && s.tgtType === tgtType
            const where = s.shared ? `shared${s.shared.createdBy ? ` by ${s.shared.createdBy}` : ''}` : unshared ? 'only in this browser' : null
            return (
              <span
                key={s.name}
                className={clsx(
                  'group inline-flex items-center rounded-full border text-xs font-medium',
                  // dashed: kept only in this browser while the team has a shared list
                  unshared > 0 && !s.shared && 'border-dashed',
                  active ? 'border-accent-500 bg-accent-50 text-accent-700 dark:bg-accent-700/20 dark:text-accent-400' : 'border-zinc-200 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400',
                )}
              >
                <button type="button" onClick={() => onChange(s.tgt, s.tgtType)} className={clsx('py-0.5 pl-2.5', !canRemove(s) && 'pr-2.5')} title={`${s.tgtType}: ${s.tgt}${where ? ` (${where})` : ''}`}>
                  {s.name}
                </button>
                {canRemove(s) && (
                  <button type="button" onClick={() => run(remove(s))} className="rounded-full p-0.5 pr-1.5 opacity-40 group-hover:opacity-100" aria-label={`Remove ${s.name}`}>
                    <X className="size-3" />
                  </button>
                )}
              </span>
            )
          })}
          {unshared > 0 && (
            <button
              type="button"
              onClick={() => run(shareLocal())}
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs text-accent-700 hover:bg-accent-50 dark:text-accent-400 dark:hover:bg-accent-700/20"
              title="Targets saved before they were shared live only in this browser"
            >
              <Share2 className="size-3" /> Share {unshared} with the team
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function TargetPreview({ hint, preview }: { hint: string; preview: Preview | null }) {
  const [expanded, setExpanded] = useState(false)
  if (!preview) {
    return (
      <span className="flex items-center gap-2">
        <span className="font-mono">{hint}</span>
        <Loader2 className="size-3 animate-spin text-zinc-500 dark:text-zinc-400" />
      </span>
    )
  }
  if (preview.error || !preview.minions) return <span className="font-mono">{hint}</span>
  const { minions } = preview
  if (minions.length === 0) {
    return (
      <span className="flex items-center gap-1.5 text-amber-700 dark:text-amber-400">
        <TriangleAlert className="size-3.5" /> Matches no known minions
      </span>
    )
  }
  const shown = expanded ? minions : minions.slice(0, 6)
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Crosshair className="size-3.5 text-accent-700 dark:text-accent-400" />
      <span className="font-medium text-zinc-700 dark:text-zinc-300">
        {minions.length} {minions.length === 1 ? 'minion' : 'minions'}:
      </span>
      {shown.map((m) => (
        <span key={m} className="rounded bg-zinc-100 px-1.5 font-mono text-[11px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
          {m}
        </span>
      ))}
      {minions.length > shown.length && (
        <button type="button" onClick={() => setExpanded(true)} className="text-accent-700 hover:underline dark:text-accent-400">
          +{minions.length - shown.length} more
        </button>
      )}
    </span>
  )
}

/** For users an admin limited to some minions: what they can run on, before they try. */
function ScopeNote() {
  const { session } = useSession()
  const s = session?.scope
  if (!s) return null
  return (
    <p className="flex items-center gap-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
      <Lock className="size-3.5 shrink-0" />
      <span>
        You can run on <span className="font-mono font-medium">{s.targetType === 'glob' ? '' : `${s.targetType}:`}{s.target}</span> only; a target that reaches other minions is refused.
      </span>
    </p>
  )
}

