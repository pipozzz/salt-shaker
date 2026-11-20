import { ChevronDown, ChevronUp, Fingerprint } from 'lucide-react'
import { useState } from 'react'
import { shortFinger } from '../lib/keys'
import { CopyButton } from './ui'

/**
 * A key's fingerprint, short until opened, with a button that copies it whole, so it can be
 * compared with `salt-call --local key.finger` on the minion.
 */
export function KeyFingerprint({ id, finger, label }: { id: string; finger: string; label?: string }) {
  const [open, setOpen] = useState(false)
  const what = label ? `${label} fingerprint` : 'fingerprint'
  return (
    <span className="flex min-w-0 max-w-full items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400">
      <Fingerprint className="size-3.5 shrink-0" />
      {label && <span className="shrink-0">{label}:</span>}
      <button
        type="button"
        className="flex min-w-0 items-center gap-1 rounded text-left font-mono hover:text-zinc-900 dark:hover:text-zinc-100"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {/* the name keeps the visible fingerprint in it, as screen-reader users hear what others see */}
        <span className="sr-only">
          {open ? 'Hide' : 'Show'} the whole {what} of {id}:{' '}
        </span>
        <span className={open ? 'break-all' : 'truncate'}>{open ? finger : shortFinger(finger)}</span>
        {open ? <ChevronUp className="size-3 shrink-0" /> : <ChevronDown className="size-3 shrink-0" />}
      </button>
      <CopyButton text={finger} ariaLabel={`Copy the ${what} of ${id}`} iconOnly />
    </span>
  )
}
