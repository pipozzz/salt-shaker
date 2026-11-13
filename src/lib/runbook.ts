import { parseArgs } from './args'

/*
 * Runbooks: a saved procedure of a few steps, each one function on a target, with parameters an
 * operator fills in when they run it ("which web server", "which certificate"). A step's target and
 * arguments may hold {{name}}; arguments are split into tokens first and the values go into the
 * tokens, so a value can never add an argument of its own. Pure, for the server and the demo.
 */

export const TARGET_TYPES = ['glob', 'list', 'grain', 'compound', 'pcre', 'pillar', 'nodegroup'] as const

export interface RunbookParam {
  /** used as {{name}} in steps */
  name: string
  label: string
  default: string
  required: boolean
}

export interface RunbookStep {
  name: string
  fun: string
  target: string
  targetType: string
  /** as typed on the Run page: positional args and key=value */
  args: string
  /** go on to the next step even when this one fails on some minions */
  continueOnFailure: boolean
  /** runs only when an earlier step stopped the run, to put things back; these come last */
  onFailure?: boolean
  /** the run waits before this step until whoever started it, or an admin, lets it go on */
  confirm?: boolean
}

export interface RunbookInput {
  name: string
  description: string
  params: RunbookParam[]
  steps: RunbookStep[]
}

/** A step as it runs: its function, target and arguments with the values filled in. */
export interface ResolvedStep {
  name: string
  fun: string
  target: string
  targetType: string
  arg: unknown[]
  kwarg: Record<string, unknown>
  continueOnFailure: boolean
  onFailure?: boolean
  confirm?: boolean
}

const PARAM = /^[a-z_][a-z0-9_]{0,30}$/
const FUN = /^[A-Za-z_][\w.]*$/
const PLACEHOLDER = /\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/g
export const MAX_STEPS = 20
const MAX_VALUE = 200

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const placeholders = (s: string) => [...s.matchAll(PLACEHOLDER)].map((m) => m[1])

/** Checks what an admin entered; returns the runbook, or a sentence saying what's wrong. */
export function readRunbook(body: Record<string, unknown>): RunbookInput | { error: string } {
  const name = str(body.name)
  if (!name || name.length > 80) return { error: 'Give it a name (80 characters at most)' }
  const description = str(body.description).slice(0, 1000)
  const rawParams = Array.isArray(body.params) ? body.params : []
  const params: RunbookParam[] = []
  for (const p of rawParams as Array<Record<string, unknown>>) {
    const pname = str(p?.name)
    if (!PARAM.test(pname)) return { error: `"${pname}" can't be a parameter name: use lowercase letters, digits and _` }
    if (params.some((x) => x.name === pname)) return { error: `The parameter ${pname} is there twice` }
    params.push({ name: pname, label: str(p.label) || pname, default: str(p.default).slice(0, MAX_VALUE), required: p.required !== false })
  }
  const rawSteps = Array.isArray(body.steps) ? body.steps : []
  if (!rawSteps.length) return { error: 'Add at least one step' }
  if (rawSteps.length > MAX_STEPS) return { error: `At most ${MAX_STEPS} steps` }
  const steps: RunbookStep[] = []
  for (const [i, s] of (rawSteps as Array<Record<string, unknown>>).entries()) {
    const n = i + 1
    const step: RunbookStep = {
      name: str(s?.name) || `Step ${n}`,
      fun: str(s?.fun),
      target: str(s?.target),
      targetType: str(s?.targetType) || 'glob',
      args: typeof s?.args === 'string' ? s.args.trim() : '',
      continueOnFailure: s?.continueOnFailure === true,
      ...(s?.onFailure === true ? { onFailure: true } : {}),
      ...(s?.confirm === true ? { confirm: true } : {}),
    }
    if (!step.onFailure && steps.some((x) => x.onFailure)) return { error: `Step ${n} runs every time, so it comes before the steps for a failure` }
    if (!FUN.test(step.fun)) return { error: `Step ${n}: the function is a name like state.apply` }
    if (!step.target) return { error: `Step ${n}: the target is required` }
    if (!(TARGET_TYPES as readonly string[]).includes(step.targetType)) return { error: `Step ${n}: unknown target type` }
    const unknown = [...placeholders(step.target), ...placeholders(step.args)].find((p) => !params.some((x) => x.name === p))
    if (unknown) return { error: `Step ${n} uses {{${unknown}}}, which isn't a parameter` }
    steps.push(step)
  }
  if (steps.every((x) => x.onFailure)) return { error: 'Add a step that runs every time, not only on a failure' }
  return { name, description, params, steps }
}

const fill = (s: string, values: Record<string, string>) => s.replace(PLACEHOLDER, (_, p: string) => values[p] ?? '')

/** Fills a value into the strings inside a parsed argument (not into keys or other types). */
function fillValue(v: unknown, values: Record<string, string>): unknown {
  if (typeof v === 'string') return fill(v, values)
  if (Array.isArray(v)) return v.map((x) => fillValue(x, values))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillValue(x, values)]))
  return v
}

/** The values to run with (defaults for what's left out), and the steps with them filled in. */
export function resolveRunbook(rb: Pick<RunbookInput, 'params' | 'steps'>, given: Record<string, unknown>): { values: Record<string, string>; steps: ResolvedStep[] } | { error: string } {
  const values: Record<string, string> = {}
  for (const p of rb.params) {
    const raw = given[p.name]
    const v = (typeof raw === 'string' ? raw.trim() : raw === undefined || raw === null ? '' : String(raw)) || p.default
    if (!v && p.required) return { error: `${p.label} is required` }
    if (v.length > MAX_VALUE) return { error: `${p.label} is longer than ${MAX_VALUE} characters` }
    if (/[\n\r]/.test(v)) return { error: `${p.label} has to fit on one line` }
    values[p.name] = v
  }
  const steps = rb.steps.map((s) => {
    const { arg, kwarg } = parseArgs(s.args)
    return {
      name: s.name,
      fun: s.fun,
      target: fill(s.target, values),
      targetType: s.targetType,
      arg: arg.map((a) => fillValue(a, values)),
      kwarg: fillValue(kwarg, values) as Record<string, unknown>,
      continueOnFailure: s.continueOnFailure,
      ...(s.onFailure ? { onFailure: true } : {}),
      ...(s.confirm ? { confirm: true } : {}),
    }
  })
  const empty = steps.find((s) => !s.target.trim())
  if (empty) return { error: `${empty.name}: the target is empty with these values` }
  return { values, steps }
}

interface StepLike extends ResolvedStep {
  status: string
  jid?: string | null
  fromRun?: number
}

/**
 * Where a finished run can be continued from: its first step that neither finished nor was
 * allowed to fail (a step that couldn't start at all stopped it, even if it may fail). Steps for a
 * failure don't count: they run again if the run fails again. Null when there's nothing left to
 * run, or it never started (rejected).
 */
export function continueFrom(run: { status: string; steps: StepLike[] }): number | null {
  if (run.status !== 'stopped' && run.status !== 'failed') return null
  const i = run.steps.findIndex((s) => !s.onFailure && !(s.status === 'done' || (s.status === 'failed' && s.continueOnFailure && !!s.jid)))
  return i < 0 ? null : i
}

/**
 * The steps of a run that continues `fromRun` at step `at`: the ones before it as they ended there
 * (with their jobs, marked with the run they ran in), the rest to run again, as they were resolved.
 */
export function continuedSteps<S extends StepLike>(steps: S[], at: number, fromRun: number): S[] {
  return steps.map((s, i) => {
    if (i < at) return { ...s, fromRun: s.fromRun ?? fromRun }
    const { name, fun, target, targetType, arg, kwarg, continueOnFailure, onFailure, confirm } = s
    return { name, fun, target, targetType, arg, kwarg, continueOnFailure, ...(onFailure ? { onFailure } : {}), ...(confirm ? { confirm } : {}), status: 'waiting' } as S
  })
}
