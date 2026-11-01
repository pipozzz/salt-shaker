import { useCallback, useEffect, useRef, useState } from 'react'
import type { TargetType } from '../api/types'
import { useSalt, useSession } from './session'

export interface JobRun {
  jid: string
  fun: string
  minions: string[]
  results: Record<string, unknown>
  /** Minions that are not running the job anymore (offline, or the return got lost). */
  gaveUp: string[]
  done: boolean
  timedOut: boolean
  started: number
}

const TIMEOUT_MS = 120_000
// returns arrive over the event bus; polling only catches what the stream missed
const POLL_MS = 3000
// like the salt CLI: after a while, ask missing minions whether they still run the job
const FIND_JOB_AFTER_MS = 6000
const FIND_JOB_EVERY_MS = 10_000

/**
 * Starts an async job and collects returns live from salt/job/<jid>/ret/* events,
 * with lookup_jid polling as a fallback (e.g. when the event stream is down).
 */
export function useJob() {
  const salt = useSalt()
  const { subscribe } = useSession()
  const [run, setRun] = useState<JobRun | null>(null)
  const cleanup = useRef<() => void>(() => undefined)

  useEffect(() => () => cleanup.current(), [])

  const merge = useCallback((jid: string, results: Record<string, unknown>) => {
    setRun((r) => {
      if (!r || r.jid !== jid || r.done) return r
      const all = { ...r.results, ...results }
      return { ...r, results: all, done: r.minions.every((m) => m in all || r.gaveUp.includes(m)) }
    })
  }, [])

  const start = useCallback(
    async (tgt: string, tgtType: TargetType, fun: string, arg: unknown[], kwarg: Record<string, unknown>) => {
      cleanup.current()
      const { jid, minions } = await salt.runAsync(tgt, tgtType, fun, arg, kwarg)
      const started = Date.now()
      setRun({ jid, fun, minions, results: {}, gaveUp: [], done: false, timedOut: false, started })

      const prefix = `salt/job/${jid}/ret/`
      const unsubscribe = subscribe((e) => {
        if (e.tag.startsWith(prefix)) merge(jid, { [e.tag.slice(prefix.length)]: e.data.return })
      })

      let timer: ReturnType<typeof setTimeout>
      let stopped = false
      let nextFindJob = started + FIND_JOB_AFTER_MS
      const tick = async () => {
        let results: Record<string, unknown> = {}
        try {
          results = await salt.lookupJid(jid)
          merge(jid, results)
        } catch {
          // keep waiting for events
        }
        if (stopped) return
        if (Date.now() >= nextFindJob) {
          nextFindJob = Date.now() + FIND_JOB_EVERY_MS
          const missing = minions.filter((m) => !(m in results))
          if (missing.length) {
            try {
              const running = await salt.call<Record<string, Record<string, unknown> | false>>({
                client: 'local',
                tgt: missing.join(','),
                tgt_type: 'list',
                fun: 'saltutil.find_job',
                arg: [jid],
                timeout: 3,
                gather_job_timeout: 2,
              })
              // no answer = offline; an empty answer = finished but its return never reached the master
              const gone = missing.filter((m) => !running[m] || Object.keys(running[m]).length === 0)
              // re-check returns first so a minion that just finished is not counted as gone
              const latest = await salt.lookupJid(jid)
              const gaveUp = gone.filter((m) => !(m in latest))
              setRun((r) => {
                if (!r || r.jid !== jid || r.done) return r
                const all = { ...r.results, ...latest }
                const done = r.minions.every((m) => m in all || gaveUp.includes(m))
                return { ...r, results: all, gaveUp, done, timedOut: done && gaveUp.length > 0 }
              })
            } catch {
              // fall back to the hard timeout
            }
          }
        }
        if (stopped) return
        if (Date.now() - started > TIMEOUT_MS) {
          setRun((r) => (r && r.jid === jid && !r.done ? { ...r, done: true, timedOut: true } : r))
          return
        }
        timer = setTimeout(tick, POLL_MS)
      }
      timer = setTimeout(tick, 500)

      cleanup.current = () => {
        stopped = true
        clearTimeout(timer)
        unsubscribe()
      }
      return jid
    },
    [salt, subscribe, merge],
  )

  /** Shows a finished job from the job cache. */
  const load = useCallback(
    async (jid: string) => {
      cleanup.current()
      const job = await salt.job(jid)
      const results = Object.fromEntries(Object.entries(job.Result ?? {}).map(([id, r]) => [id, r.return]))
      const minions = job.Minions ?? Object.keys(results)
      setRun({ jid, fun: job.Function, minions, results, gaveUp: minions.filter((m) => !(m in results)), done: true, timedOut: false, started: salt.jidDate(jid)?.getTime() ?? Date.now() })
    },
    [salt],
  )

  // stop listening once everything is in
  useEffect(() => {
    if (run?.done) cleanup.current()
  }, [run?.done])

  return { run, start, load, setRun }
}
