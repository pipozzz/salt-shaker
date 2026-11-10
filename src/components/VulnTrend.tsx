import { useEffect, useRef, useState, type MouseEvent } from 'react'
import type { VulnDay } from '../api/server'

/*
 * The vulnerability report's daily totals as a small line chart: critical, high, and how many have a
 * fix. One y-axis, thin lines, a legend, and a crosshair with every value of the hovered day.
 */

const SERIES = [
  { key: 'critical', label: 'Critical', line: 'stroke-red-600 dark:stroke-red-400', dot: 'bg-red-600 dark:bg-red-400' },
  { key: 'high', label: 'High', line: 'stroke-amber-600 dark:stroke-amber-400', dot: 'bg-amber-600 dark:bg-amber-400' },
  { key: 'fixable', label: 'With a fix', line: 'stroke-accent-600 dark:stroke-accent-400', dot: 'bg-accent-600 dark:bg-accent-400' },
] as const

const H = 150
const PAD = { top: 8, right: 8, bottom: 20, left: 32 }

/** 0, a round step, and a top a little above the highest value */
function ticks(max: number): number[] {
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000].find((s) => max / s <= 4) ?? Math.ceil(max / 4)
  return Array.from({ length: Math.floor(max / step) + 2 }, (_, i) => i * step)
}

const fmtDay = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })

export function VulnTrend({ days }: { days: VulnDay[] }) {
  const [hover, setHover] = useState<number | null>(null)
  // drawn in real pixels at the container's width, so text and lines keep their size
  const box = useRef<HTMLDivElement>(null)
  const [W, setW] = useState(640)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.round(e.contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const max = Math.max(1, ...days.flatMap((d) => SERIES.map((s) => d[s.key])))
  const yTicks = ticks(max)
  const top = yTicks[yTicks.length - 1]
  const x = (i: number) => PAD.left + (days.length === 1 ? 0 : (i / (days.length - 1)) * (W - PAD.left - PAD.right))
  const y = (v: number) => PAD.top + (1 - v / top) * (H - PAD.top - PAD.bottom)
  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    const px = ((e.clientX - box.left) / box.width) * W
    const i = Math.round(((px - PAD.left) / (W - PAD.left - PAD.right)) * (days.length - 1))
    setHover(Math.max(0, Math.min(days.length - 1, i)))
  }
  const h = hover === null ? null : days[hover]
  const first = days[0]
  const last = days[days.length - 1]

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-600 dark:text-zinc-400">
        {SERIES.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className={`h-0.5 w-3 rounded-full ${s.dot}`} />
            {s.label}
            <span className="font-medium text-zinc-900 tabular-nums dark:text-zinc-100">{last[s.key]}</span>
            {first !== last && <Delta from={first[s.key]} to={last[s.key]} />}
          </span>
        ))}
      </div>
      <div className="relative" ref={box}>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block max-w-full" role="img" aria-label={`Vulnerabilities over ${days.length} days: ${SERIES.map((s) => `${s.label.toLowerCase()} ${first[s.key]} to ${last[s.key]}`).join(', ')}`} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className="stroke-zinc-200 dark:stroke-zinc-800" strokeWidth={1} />
              <text x={PAD.left - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-zinc-500 text-[10px] tabular-nums dark:fill-zinc-400">
                {t}
              </text>
            </g>
          ))}
          <text x={PAD.left} y={H - 4} className="fill-zinc-500 text-[10px] dark:fill-zinc-400">
            {fmtDay(first.day)}
          </text>
          <text x={W - PAD.right} y={H - 4} textAnchor="end" className="fill-zinc-500 text-[10px] dark:fill-zinc-400">
            {fmtDay(last.day)}
          </text>
          {SERIES.map((s) => (
            <polyline key={s.key} points={days.map((d, i) => `${x(i)},${y(d[s.key])}`).join(' ')} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" className={s.line} />
          ))}
          {hover !== null && h && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={H - PAD.bottom} className="stroke-zinc-400 dark:stroke-zinc-500" strokeWidth={1} />
              {SERIES.map((s) => (
                <circle key={s.key} cx={x(hover)} cy={y(h[s.key])} r={4} strokeWidth={2} className={`fill-white dark:fill-zinc-900 ${s.line}`} />
              ))}
            </g>
          )}
        </svg>
        {hover !== null && h && (
          <div
            className="pointer-events-none absolute top-0 z-10 min-w-36 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs shadow-md dark:border-zinc-700 dark:bg-zinc-900"
            style={hover > days.length / 2 ? { right: `${100 - (x(hover) / W) * 100 + 2}%` } : { left: `${(x(hover) / W) * 100 + 2}%` }}
          >
            <div className="mb-1 font-medium text-zinc-900 dark:text-zinc-100">{fmtDay(h.day)}</div>
            {SERIES.map((s) => (
              <div key={s.key} className="flex items-center gap-2 text-zinc-600 dark:text-zinc-400">
                <span className={`h-0.5 w-3 rounded-full ${s.dot}`} />
                {s.label}
                <span className="ml-auto font-medium text-zinc-900 tabular-nums dark:text-zinc-100">{h[s.key]}</span>
              </div>
            ))}
            <div className="mt-1 text-zinc-500 dark:text-zinc-400">
              {h.affected}/{h.minions} minions affected
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Delta({ from, to }: { from: number; to: number }) {
  if (from === to) return null
  return (
    <span className="text-zinc-500 tabular-nums dark:text-zinc-400">
      ({to > from ? '+' : '−'}
      {Math.abs(to - from)})
    </span>
  )
}
