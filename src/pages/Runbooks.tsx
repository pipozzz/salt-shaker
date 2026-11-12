import { ArrowDown, ArrowUp, BookOpen, Pencil, Play, Plus, Trash2, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { Runbook } from '../api/server'
import { Badge, Button, Card, CardHeader, Empty, ErrorBox, Field, Input, Modal, PageHeader, Select, Spinner } from '../components/ui'
import { relTime } from '../lib/format'
import { useAsync } from '../lib/hooks'
import { TARGET_TYPES, type RunbookInput, type RunbookParam, type RunbookStep } from '../lib/runbook'
import { RUN_STATUS, useRunbookRole, useRunbooksApi } from '../lib/runbooks'

const stepText = (s: RunbookStep) => `${s.fun}${s.args ? ` ${s.args}` : ''} → ${s.targetType === 'glob' ? '' : `${s.targetType}:`}${s.target}`

/** Saved procedures of a few steps: run one with its values, follow it step by step. */
export function RunbooksPage() {
  const api = useRunbooksApi()
  const { canWrite, canRun } = useRunbookRole()
  const [reloads, setReloads] = useState(0)
  const list = useAsync(() => (api ? api.list() : Promise.resolve(null)), [api, reloads])
  const runs = useAsync(() => (api ? api.runs() : Promise.resolve(null)), [api, reloads])
  const [editing, setEditing] = useState<Runbook | 'new' | null>(null)
  const [running, setRunning] = useState<Runbook | null>(null)
  const [removing, setRemoving] = useState<Runbook | null>(null)
  const [removeError, setRemoveError] = useState<Error | null>(null)
  if (!api) return null

  return (
    <>
      <PageHeader
        title="Runbooks"
        description="Procedures of a few steps, saved once and run by anyone who may: each step runs as you, waits for its minions, and stops the run when it fails."
        actions={
          canWrite && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
              New runbook
            </Button>
          )
        }
      />
      {list.error && <ErrorBox error={list.error} onRetry={list.reload} />}
      {list.loading && !list.data && <Spinner />}
      {list.data && list.data.runbooks.length === 0 && (
        <Card>
          <Empty icon={<BookOpen />} title="No runbooks yet">
            {canWrite ? 'Write down a procedure your team repeats: its steps, and the values that change each time.' : 'An admin writes them; you run them here.'}
          </Empty>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {list.data?.runbooks.map((rb) => (
          <Card key={rb.id} className="flex flex-col">
            <CardHeader
              title={rb.name}
              subtitle={rb.description || undefined}
              actions={
                <div className="flex gap-1">
                  {canWrite && <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} aria-label={`Edit ${rb.name}`} onClick={() => setEditing(rb)} />}
                  {canWrite && <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} aria-label={`Delete ${rb.name}`} onClick={() => setRemoving(rb)} />}
                </div>
              }
            />
            <ol className="flex-1 space-y-1.5 p-4 text-sm">
              {rb.steps.map((s, i) => (
                <li key={i} className="flex gap-2">
                  <span className="w-5 shrink-0 text-right text-xs tabular-nums text-zinc-400">{i + 1}.</span>
                  <span className="min-w-0">
                    <span className="font-medium">{s.name}</span>
                    {s.continueOnFailure && <span className="ml-1.5 text-xs text-zinc-500 dark:text-zinc-400">(may fail)</span>}
                    <span className="block truncate font-mono text-xs text-zinc-500 dark:text-zinc-400" title={stepText(s)}>
                      {stepText(s)}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
            <div className="flex items-center justify-between gap-2 border-t border-zinc-100 px-4 py-3 dark:border-zinc-800">
              <span className="text-xs text-zinc-500 dark:text-zinc-400">{rb.params.length ? `Asks for ${rb.params.map((p) => p.label).join(', ')}` : 'No values to fill in'}</span>
              {canRun && (
                <Button size="sm" variant="primary" icon={<Play className="size-3.5" />} onClick={() => setRunning(rb)}>
                  Run…
                </Button>
              )}
            </div>
          </Card>
        ))}
      </div>

      <Card className="mt-6">
        <CardHeader title="Recent runs" />
        {runs.data && runs.data.runs.length > 0 ? (
          <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800/70">
            {runs.data.runs.map((r) => (
              <li key={r.id}>
                <Link to={`/runbooks/runs/${r.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 hover:bg-zinc-50 dark:hover:bg-zinc-900/60">
                  <span className="text-xs tabular-nums text-zinc-400">#{r.id}</span>
                  <span className="font-medium">{r.name}</span>
                  <Badge tone={RUN_STATUS[r.status].tone}>{RUN_STATUS[r.status].label}</Badge>
                  <span className="truncate font-mono text-xs text-zinc-500 dark:text-zinc-400">{Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(' ')}</span>
                  <span className="ml-auto text-xs text-zinc-500 dark:text-zinc-400">
                    {r.startedBy} · {relTime(new Date(r.startedAt))}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="p-4 text-sm text-zinc-500 dark:text-zinc-400">{runs.loading ? 'Loading…' : 'Nothing has run yet.'}</p>
        )}
      </Card>

      {editing && <RunbookEditor runbook={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => setReloads((n) => n + 1)} />}
      {running && <RunModal runbook={running} onClose={() => setRunning(null)} />}
      <Modal
        open={!!removing}
        onClose={() => {
          setRemoving(null)
          setRemoveError(null)
        }}
        title={`Delete ${removing?.name}?`}
      >
        <p className="text-sm text-zinc-600 dark:text-zinc-400">Its past runs stay in the list and in the audit log.</p>
        {removeError && (
          <div className="mt-3">
            <ErrorBox error={removeError} />
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button
            onClick={() => {
              setRemoving(null)
              setRemoveError(null)
            }}
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={async () => {
              setRemoveError(null)
              try {
                await api.remove(removing!.id)
                setRemoving(null)
                setReloads((n) => n + 1)
              } catch (e) {
                setRemoveError(e as Error)
              }
            }}
          >
            Delete
          </Button>
        </div>
      </Modal>
    </>
  )
}

/** Asks for the runbook's values, starts it, and opens the run. */
function RunModal({ runbook, onClose }: { runbook: Runbook; onClose: () => void }) {
  const api = useRunbooksApi()!
  const navigate = useNavigate()
  const [values, setValues] = useState<Record<string, string>>(Object.fromEntries(runbook.params.map((p) => [p.name, p.default])))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const { run } = await api.run(runbook.id, values)
      navigate(`/runbooks/runs/${run.id}`)
    } catch (err) {
      setError(err as Error)
      setBusy(false)
    }
  }
  return (
    <Modal open onClose={onClose} title={`Run ${runbook.name}`}>
      <form onSubmit={submit} className="space-y-4">
        {runbook.params.map((p) => (
          <Field key={p.name} label={p.label} hint={`{{${p.name}}}${p.required ? '' : ', optional'}`}>
            <Input value={values[p.name] ?? ''} onChange={(e) => setValues({ ...values, [p.name]: e.target.value })} required={p.required} aria-label={p.label} className="font-mono" />
          </Field>
        ))}
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          {runbook.steps.length} {runbook.steps.length === 1 ? 'step runs' : 'steps run'} one after another, as you. A step that fails stops the run, unless it may fail.
        </p>
        {error && <ErrorBox error={error} />}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" icon={<Play className="size-4" />} loading={busy}>
            Run
          </Button>
        </div>
      </form>
    </Modal>
  )
}

const emptyStep = (): RunbookStep => ({ name: '', fun: '', target: '', targetType: 'glob', args: '', continueOnFailure: false })
const emptyParam = (): RunbookParam => ({ name: '', label: '', default: '', required: true })

/** Admins: the runbook's values to ask for, and its steps in order. */
function RunbookEditor({ runbook, onClose, onSaved }: { runbook: Runbook | null; onClose: () => void; onSaved: () => void }) {
  const api = useRunbooksApi()!
  const [rb, setRb] = useState<RunbookInput>(() => (runbook ? { name: runbook.name, description: runbook.description, params: runbook.params.map((p) => ({ ...p })), steps: runbook.steps.map((s) => ({ ...s })) } : { name: '', description: '', params: [], steps: [emptyStep()] }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const setStep = (i: number, patch: Partial<RunbookStep>) => setRb({ ...rb, steps: rb.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) })
  const setParam = (i: number, patch: Partial<RunbookParam>) => setRb({ ...rb, params: rb.params.map((p, j) => (j === i ? { ...p, ...patch } : p)) })
  const move = (i: number, d: -1 | 1) => {
    const steps = [...rb.steps]
    ;[steps[i], steps[i + d]] = [steps[i + d], steps[i]]
    setRb({ ...rb, steps })
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.save(rb, runbook?.id)
      onSaved()
      onClose()
    } catch (err) {
      setError(err as Error)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open onClose={onClose} title={runbook ? `Edit ${runbook.name}` : 'New runbook'} wide>
      <form onSubmit={submit} className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <Input value={rb.name} onChange={(e) => setRb({ ...rb, name: e.target.value })} placeholder="Restart a service safely" required aria-label="Runbook name" />
          </Field>
          <Field label="What it's for">
            <Input value={rb.description} onChange={(e) => setRb({ ...rb, description: e.target.value })} aria-label="Description" />
          </Field>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Values to ask for</legend>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Use them in a step's target or arguments as <code className="font-mono">{'{{name}}'}</code>. A value stays inside its argument: it can't add arguments of its own.
          </p>
          {rb.params.map((p, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2">
              <Field label="Name">
                <Input value={p.name} onChange={(e) => setParam(i, { name: e.target.value })} placeholder="host" className="w-32 font-mono" aria-label={`Value ${i + 1} name`} />
              </Field>
              <Field label="Asked as">
                <Input value={p.label} onChange={(e) => setParam(i, { label: e.target.value })} placeholder="Minion" className="w-40" aria-label={`Value ${i + 1} label`} />
              </Field>
              <Field label="Default">
                <Input value={p.default} onChange={(e) => setParam(i, { default: e.target.value })} className="w-36 font-mono" aria-label={`Value ${i + 1} default`} />
              </Field>
              <label className="flex h-9 items-center gap-1.5 text-sm">
                <input type="checkbox" checked={p.required} onChange={(e) => setParam(i, { required: e.target.checked })} className="accent-accent-600" /> required
              </label>
              <Button type="button" size="sm" variant="ghost" icon={<X className="size-3.5" />} aria-label={`Remove value ${i + 1}`} onClick={() => setRb({ ...rb, params: rb.params.filter((_, j) => j !== i) })} />
            </div>
          ))}
          <Button type="button" size="sm" icon={<Plus className="size-3.5" />} onClick={() => setRb({ ...rb, params: [...rb.params, emptyParam()] })}>
            Add a value
          </Button>
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">Steps, in order</legend>
          {rb.steps.map((s, i) => (
            <div key={i} className="space-y-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium tabular-nums text-zinc-500">{i + 1}.</span>
                <Input value={s.name} onChange={(e) => setStep(i, { name: e.target.value })} placeholder={`Step ${i + 1}`} aria-label={`Step ${i + 1} name`} />
                <Button type="button" size="sm" variant="ghost" icon={<ArrowUp className="size-3.5" />} aria-label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)} />
                <Button type="button" size="sm" variant="ghost" icon={<ArrowDown className="size-3.5" />} aria-label={`Move step ${i + 1} down`} disabled={i === rb.steps.length - 1} onClick={() => move(i, 1)} />
                <Button type="button" size="sm" variant="ghost" icon={<X className="size-3.5" />} aria-label={`Remove step ${i + 1}`} disabled={rb.steps.length === 1} onClick={() => setRb({ ...rb, steps: rb.steps.filter((_, j) => j !== i) })} />
              </div>
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_7rem_minmax(0,1fr)_minmax(0,1.4fr)]">
                <Input value={s.target} onChange={(e) => setStep(i, { target: e.target.value })} placeholder="{{host}}" className="font-mono" aria-label={`Step ${i + 1} target`} />
                <Select value={s.targetType} onChange={(e) => setStep(i, { targetType: e.target.value })} aria-label={`Step ${i + 1} match by`}>
                  {TARGET_TYPES.map((tt) => (
                    <option key={tt} value={tt}>
                      {tt}
                    </option>
                  ))}
                </Select>
                <Input value={s.fun} onChange={(e) => setStep(i, { fun: e.target.value })} placeholder="service.restart" className="font-mono" aria-label={`Step ${i + 1} function`} />
                <Input value={s.args} onChange={(e) => setStep(i, { args: e.target.value })} placeholder="{{service}}" className="font-mono" aria-label={`Step ${i + 1} arguments`} />
              </div>
              <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                <input type="checkbox" checked={s.continueOnFailure} onChange={(e) => setStep(i, { continueOnFailure: e.target.checked })} className="accent-accent-600" /> go on to the next step even if this one fails
              </label>
            </div>
          ))}
          <Button type="button" size="sm" icon={<Plus className="size-3.5" />} onClick={() => setRb({ ...rb, steps: [...rb.steps, emptyStep()] })}>
            Add a step
          </Button>
        </fieldset>

        {error && <ErrorBox error={error} />}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy}>
            {runbook ? 'Save' : 'Create runbook'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
