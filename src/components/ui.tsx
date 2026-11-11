import clsx from 'clsx'
import { AlertTriangle, Check, Copy, Loader2, Lock, X } from 'lucide-react'
import { useEffect, useState, type ButtonHTMLAttributes, type AnchorHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success'

const buttonCls = (variant: Variant = 'secondary', size: 'sm' | 'md' = 'md') =>
  clsx(
    'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 disabled:cursor-not-allowed disabled:opacity-50',
    size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-9 px-3.5 text-sm',
    variant === 'primary' && 'bg-accent-700 text-white shadow-sm hover:bg-accent-800',
    variant === 'secondary' && 'border border-zinc-200 bg-white text-zinc-700 shadow-xs hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800',
    variant === 'ghost' && 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800/70',
    variant === 'danger' && 'border border-red-200 bg-white text-red-600 hover:bg-red-50 dark:border-red-900/60 dark:bg-transparent dark:text-red-400 dark:hover:bg-red-950/50',
    variant === 'success' && 'bg-emerald-700 text-white shadow-sm hover:bg-emerald-800',
  )

export function Button({
  variant = 'secondary',
  size = 'md',
  loading,
  icon,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean; icon?: ReactNode }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={clsx(buttonCls(variant, size), className)}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  )
}

/** A link that looks like a button, e.g. for downloads the browser should handle. */
export function ButtonLink({ variant, size, icon, className, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: Variant; size?: 'sm' | 'md'; icon?: ReactNode }) {
  return (
    <a {...rest} className={clsx(buttonCls(variant, size), className)}>
      {icon}
      {children}
    </a>
  )
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={clsx('rounded-xl border border-zinc-200 bg-white shadow-xs dark:border-zinc-800 dark:bg-zinc-900/60', className)}>{children}</div>
  )
}

export function CardHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold">{title}</h3>
        {subtitle && <p className="text-xs text-zinc-500 dark:text-zinc-400">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}

const tones = {
  zinc: 'bg-zinc-100 text-zinc-700 ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-700',
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-400 dark:ring-emerald-900',
  red: 'bg-red-50 text-red-700 ring-red-200 dark:bg-red-950/60 dark:text-red-400 dark:ring-red-900',
  amber: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/60 dark:text-amber-400 dark:ring-amber-900',
  blue: 'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-950/60 dark:text-sky-400 dark:ring-sky-900',
  accent: 'bg-accent-50 text-accent-700 ring-accent-100 dark:bg-accent-700/20 dark:text-accent-400 dark:ring-accent-700/40',
}
export type Tone = keyof typeof tones

export function Badge({ tone = 'zinc', children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={clsx('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset', tones[tone], className)}>
      {children}
    </span>
  )
}

export function StatusDot({ up }: { up: boolean | undefined }) {
  return (
    <span className="relative inline-flex size-2.5">
      {up && <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400 opacity-40" />}
      <span className={clsx('relative inline-flex size-2.5 rounded-full', up === undefined ? 'bg-zinc-300 dark:bg-zinc-600' : up ? 'bg-emerald-500' : 'bg-red-500')} />
    </span>
  )
}

const fieldCls =
  'h-9 w-full rounded-lg border border-zinc-200 bg-white px-3 text-sm shadow-xs placeholder:text-zinc-400 focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none dark:border-zinc-800 dark:bg-zinc-900 dark:placeholder:text-zinc-600'

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={clsx(fieldCls, className)} />
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={clsx(fieldCls, 'pr-8', className)}>
      {children}
    </select>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{label}</span>
      {children}
      {hint && <span className="block text-xs text-zinc-500 dark:text-zinc-400">{hint}</span>}
    </label>
  )
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

/** Explains why an action is unavailable for the logged-in user. */
export function PermNote({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={clsx('flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400', className)}>
      <Lock className="size-3.5 shrink-0" /> {children}
    </p>
  )
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-zinc-500 dark:text-zinc-400">
      <Loader2 className="size-4 animate-spin" /> {label ?? 'Loading…'}
    </div>
  )
}

export function ErrorBox({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <div className="flex-1 break-words">{error.message}</div>
      {onRetry && (
        <Button size="sm" variant="danger" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  )
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      {icon && <div className="text-zinc-300 dark:text-zinc-700 [&>svg]:size-8">{icon}</div>}
      <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{title}</p>
      {children && <div className="max-w-sm text-sm text-zinc-500 dark:text-zinc-400">{children}</div>}
    </div>
  )
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!done) return
    const t = setTimeout(() => setDone(false), 1500)
    return () => clearTimeout(t)
  }, [done])
  return (
    <Button
      size="sm"
      variant="ghost"
      icon={done ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
      onClick={() => navigator.clipboard.writeText(text).then(() => setDone(true))}
    >
      {label ?? (done ? 'Copied' : 'Copy')}
    </Button>
  )
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-zinc-950/40 p-4 backdrop-blur-sm sm:pt-[10vh]" onMouseDown={onClose}>
      <div
        className={clsx('w-full rounded-xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-900', wide ? 'max-w-3xl' : 'max-w-lg')}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3.5 dark:border-zinc-800">
          <h2 className="font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded-md p-1 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 dark:text-zinc-400" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  )
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: Array<{ value: T; label: ReactNode }> }) {
  return (
    <div className="inline-flex rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800/70">
      {items.map((it) => (
        <button
          key={it.value}
          onClick={() => onChange(it.value)}
          aria-pressed={value === it.value}
          className={clsx(
            'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
            value === it.value ? 'bg-white text-zinc-900 shadow-xs dark:bg-zinc-950 dark:text-zinc-100' : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200',
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  )
}

export function Stat({ label, value, icon, tone = 'zinc', hint }: { label: string; value: ReactNode; icon: ReactNode; tone?: Tone; hint?: ReactNode }) {
  return (
    // as tall as its row, with the hint at the bottom, so stats side by side line up
    <Card className="flex h-full flex-col p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-zinc-500 dark:text-zinc-400" title={label}>
            {label}
          </p>
          <p className="mt-1.5 text-2xl font-semibold tabular-nums">{value}</p>
        </div>
        <div className={clsx('rounded-lg p-2 ring-1 ring-inset [&>svg]:size-4', tones[tone])}>{icon}</div>
      </div>
      {hint && <p className="mt-auto pt-2 text-xs text-zinc-500 dark:text-zinc-400">{hint}</p>}
    </Card>
  )
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 disabled:opacity-50',
        checked ? 'bg-accent-700' : 'bg-zinc-300 dark:bg-zinc-700',
      )}
    >
      <span className={clsx('inline-block size-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-4.5' : 'translate-x-0.5')} />
    </button>
  )
}

/** Footer for a list rendered with usePaged(). */
export function ShowMore({ paged }: { paged: { visible: unknown[]; remaining: number; total: number; showMore: () => void; size: number } }) {
  if (!paged.remaining) return null
  return (
    <div className="flex items-center justify-center gap-3 border-t border-zinc-100 p-3 text-sm dark:border-zinc-800">
      <span className="text-zinc-500 dark:text-zinc-400">
        Showing {paged.visible.length} of {paged.total}
      </span>
      <Button size="sm" onClick={paged.showMore}>
        Show {Math.min(paged.size, paged.remaining)} more
      </Button>
    </div>
  )
}
