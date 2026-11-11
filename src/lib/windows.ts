/*
 * Maintenance windows: when changes are expected. A window opens on some weekdays at a local time
 * in its own timezone and stays open for a while (it may run past midnight). Schedules tied to a
 * window wait for it; Run and Changes say when you're outside every window. Pure, for both sides.
 */

export interface MaintenanceWindow {
  id: number
  name: string
  /** weekdays it opens on, 0 = Sunday */
  days: number[]
  /** local opening time, HH:MM */
  start: string
  /** how long it stays open, at most a day */
  minutes: number
  /** IANA timezone, e.g. Europe/Bratislava */
  timezone: string
}

export type Opening = { start: Date; end: Date }

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

const formatters = new Map<string, Intl.DateTimeFormat>()
function formatter(timezone: string) {
  let f = formatters.get(timezone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    formatters.set(timezone, f)
  }
  return f
}

/** The wall clock in `timezone` at an instant, as if it were UTC. */
function wallClock(at: number, timezone: string) {
  const p = Object.fromEntries(formatter(timezone).formatToParts(at).map((x) => [x.type, x.value]))
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second)
}

/** The instant a wall-clock time (given as if UTC) happens in `timezone`; twice-corrected for DST. */
function fromWallClock(wall: number, timezone: string) {
  let t = wall - (wallClock(wall, timezone) - wall)
  t = wall - (wallClock(t, timezone) - t)
  return t
}

export function isTimezone(tz: string) {
  try {
    formatter(tz)
    return true
  } catch {
    return false
  }
}

export function parseTime(hhmm: string) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(hhmm.trim())
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

/** The window's opening on the local day `wallDay` (midnight, as if UTC), if it opens that day. */
function openingOn(w: MaintenanceWindow, wallDay: number): Opening | null {
  if (!w.days.includes(new Date(wallDay).getUTCDay())) return null
  const start = fromWallClock(wallDay + (parseTime(w.start) ?? 0) * MINUTE, w.timezone)
  return { start: new Date(start), end: new Date(start + w.minutes * MINUTE) }
}

const localMidnight = (at: number, timezone: string) => {
  const wall = wallClock(at, timezone)
  return wall - (wall % DAY)
}

/** The opening that `at` falls in, or null when the window is closed then. */
export function openingAt(w: MaintenanceWindow, at: Date | number): Opening | null {
  const t = +at
  const today = localMidnight(t, w.timezone)
  // one that opened today, or yesterday and runs past midnight
  for (const day of [today, today - DAY]) {
    const o = openingOn(w, day)
    if (o && +o.start <= t && t < +o.end) return o
  }
  return null
}

/** The opening `from` is in, or the next one to come (null if it never opens). */
export function nextOpening(w: MaintenanceWindow, from: Date | number): Opening | null {
  const now = openingAt(w, from)
  if (now) return now
  const t = +from
  const today = localMidnight(t, w.timezone)
  for (let k = 0; k <= 7; k++) {
    const o = openingOn(w, today + k * DAY)
    if (o && +o.start > t) return o
  }
  return null
}

/** Across windows: the one open at `at`, else the soonest to open. */
export function windowState(windows: MaintenanceWindow[], at: Date | number) {
  let next: (Opening & { window: MaintenanceWindow }) | null = null
  for (const w of windows) {
    const open = openingAt(w, at)
    if (open) return { open: { ...open, window: w }, next: null }
    const o = nextOpening(w, at)
    if (o && (!next || o.start < next.start)) next = { ...o, window: w }
  }
  return { open: null, next }
}

/** "Tue, Thu 22:00 for 4 h (Europe/Bratislava)" */
export function describeWindow(w: Pick<MaintenanceWindow, 'days' | 'start' | 'minutes' | 'timezone'>) {
  const days = w.days.length === 7 ? 'Every day' : [...w.days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => DAY_NAMES[d]).join(', ')
  const h = Math.floor(w.minutes / 60)
  const m = w.minutes % 60
  const length = [h && `${h} h`, m && `${m} min`].filter(Boolean).join(' ')
  return `${days} ${w.start} for ${length} (${w.timezone})`
}

/** Checks an admin's input; returns the window's fields or a sentence saying what's wrong. */
export function readWindow(body: Record<string, unknown>): { error: string } | Omit<MaintenanceWindow, 'id'> {
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name || name.length > 60) return { error: 'Give it a name (60 characters at most)' }
  const days = Array.isArray(body.days) ? [...new Set(body.days)] : []
  if (!days.length || !days.every((d) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6)) return { error: 'Pick at least one day' }
  const start = typeof body.start === 'string' ? body.start.trim() : ''
  const at = parseTime(start)
  if (at === null) return { error: 'The start is a time like 22:00' }
  const minutes = Number(body.minutes)
  if (!Number.isInteger(minutes) || minutes < 15 || minutes > 24 * 60) return { error: 'A window lasts from 15 minutes to 24 hours' }
  const timezone = typeof body.timezone === 'string' ? body.timezone.trim() : ''
  if (!timezone || !isTimezone(timezone)) return { error: 'Pick a timezone like Europe/Bratislava' }
  const hh = String(Math.floor(at / 60)).padStart(2, '0')
  const mm = String(at % 60).padStart(2, '0')
  return { name, days: (days as number[]).sort(), start: `${hh}:${mm}`, minutes, timezone }
}
