import { ArrowDown, ArrowUp, BookOpen, Download, Pencil, Play, Plus, Trash2, Upload, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { Runbook } from '../api/server'
import { Badge, Button, Card, CardHeader, Empty, ErrorBox, Field, Input, Modal, PageHeader, Select, Spinner } from '../components/ui'
import { download } from '../lib/export'
import { relTime } from '../lib/format'
import { useAsync } from '../lib/hooks'
import { fileName, readRunbookFile, runbooksToYaml } from '../lib/runbook-file'
import { TARGET_TYPES, type RunbookInput, type RunbookParam, type RunbookStep } from '../lib/runbook'
import { RUN_STATUS, runnersText, useRunbookRole, useRunbooksApi, useUsersForRunbooks } from '../lib/runbooks'
import { RunbookHooksCard } from './RunbookHooks'

const stepText = (s: RunbookStep) => `${s.fun}${s.args ? ` ${s.args}` : ''} → ${s.targetType === 'glob' ? '' : `${s.targetType}:`}${s.target}`

/** Saved procedures of a few steps: run one with its values, follow it step by step. */
export function RunbooksPage() {
  const api = useRunbooksApi()
  const { canWrite, mayRun } = useRunbookRole()
  const [reloads, setReloads] = useState(0)
  const list = useAsync(() => (api ? api.list() : Promise.resolve(null)), [api, reloads])
  const runs = useAsync(() => (api ? api.runs() : Promise.resolve(null)), [api, reloads])
  const [editing, setEditing] = useState<Runbook | 'new' | null>(null)
  const [running, setRunning] = useState<Runbook | null>(null)
  const [removing, setRemoving] = useState<Runbook | null>(null)
  const [importing, setImporting] = useState(false)
  const exportFile = (rbs: Runbook[]) => download(fileName(rbs), 'application/yaml', runbooksToYaml(rbs))
  const [removeError, setRemoveError] = useState<Error | null>(null)
  if (!api) return null

  return (
    <>
      <PageHeader
        title="Runbooks"
        description="Procedures of a few steps, saved once and run by anyone who may: each step runs as you, waits for its minions, and stops the run when it fails."
        actions={
          <div className="flex flex-wrap gap-2">
            {!!list.data?.runbooks.length && (
              <Button icon={<Download className="size-4" />} onClick={() => exportFile(list.data!.runbooks)}>
                Export all
              </Button>
            )}
            {canWrite && (
              <Button icon={<Upload className="size-4" />} onClick={() => setImporting(true)}>
                Import…
              </Button>
            )}
            {canWrite && (
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
                New runbook
              </Button>
            )}
          </div>
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
                  <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />} aria-label={`Export ${rb.name}`} title="Export as YAML" onClick={() => exportFile([rb])} />
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
                    {s.onFailure && <span className="ml-1.5 text-xs text-amber-700 dark:text-amber-400">(if it fails)</span>}
                    {s.confirm && <span className="ml-1.5 text-xs text-zinc-500 dark:text-zinc-400">(asks first)</span>}
                    <span className="block truncate font-mono text-xs text-zinc-500 dark:text-zinc-400" title={stepText(s)}>
                      {stepText(s)}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
            <div className="flex items-center justify-between gap-2 border-t border-zinc-100 px-4 py-3 dark:border-zinc-800">
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                {rb.params.length ? `Asks for ${rb.params.map((p) => p.label).join(', ')}` : 'No values to fill in'}
                {!!rb.runners?.length && <span className="block">Run by {runnersText(rb.runners)}</span>}
              </span>
              {mayRun(rb) && (
                <Button size="sm" variant="primary" icon={<Play className="size-3.5" />} onClick={() => setRunning(rb)}>
                  Run…
                </Button>
              )}
            </div>
          </Card>
        ))}
      </div>

      {canWrite && list.data && <RunbookHooksCard runbooks={list.data.runbooks} />}

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

      {importing && list.data && <ImportModal existing={list.data.runbooks.map((rb) => rb.name)} onClose={() => setImporting(false)} onDone={() => setReloads((n) => n + 1)} />}
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

/** Asks for the runbook's values (its defaults, or a past run's), starts it, and opens the run. */
export function RunModal({ runbook, initial, onClose }: { runbook: Runbook; initial?: Record<string, string>; onClose: () => void }) {
  const api = useRunbooksApi()!
  const navigate = useNavigate()
  const [values, setValues] = useState<Record<string, string>>(Object.fromEntries(runbook.params.map((p) => [p.name, initial?.[p.name] ?? p.default])))
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
          {runbook.steps.filter((s) => !s.onFailure).length} {runbook.steps.filter((s) => !s.onFailure).length === 1 ? 'step runs' : 'steps run'} one after another, as you. A step that fails stops the run, unless it may fail
          {runbook.steps.some((s) => s.onFailure) ? '; then the steps for a failure run.' : '.'}
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
  const [rb, setRb] = useState<RunbookInput>(() => (runbook ? { name: runbook.name, description: runbook.description, params: runbook.params.map((p) => ({ ...p })), steps: runbook.steps.map((s) => ({ ...s })), runners: [...(runbook.runners ?? [])] } : { name: '', description: '', params: [], steps: [emptyStep()], runners: [] }))
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
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {!s.onFailure && (
                  <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                    <input type="checkbox" checked={s.continueOnFailure} onChange={(e) => setStep(i, { continueOnFailure: e.target.checked })} className="accent-accent-600" /> go on to the next step even if this one fails
                  </label>
                )}
                <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                  <input type="checkbox" checked={!!s.confirm} onChange={(e) => setStep(i, { confirm: e.target.checked })} className="accent-accent-600" aria-label={`Step ${i + 1} asks first`} /> wait
                  for someone to go on before this step
                </label>
                <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                  <input type="checkbox" checked={!!s.onFailure} onChange={(e) => setStep(i, { onFailure: e.target.checked, ...(e.target.checked ? { continueOnFailure: false } : {}) })} className="accent-accent-600" aria-label={`Step ${i + 1} runs only if the run fails`} /> run only
                  if a step before stops the run, to put things back (these come last)
                </label>
              </div>
            </div>
          ))}
          <Button type="button" size="sm" icon={<Plus className="size-3.5" />} onClick={() => setRb({ ...rb, steps: [...rb.steps, emptyStep()] })}>
            Add a step
          </Button>
        </fieldset>

        <RunnersField runners={rb.runners ?? []} onChange={(runners) => setRb({ ...rb, runners })} />

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

/** Who may run it: the operators it names, or every operator when it names none; admins always. */
function RunnersField({ runners, onChange }: { runners: string[]; onChange: (runners: string[]) => void }) {
  const usersApi = useUsersForRunbooks()
  const list = useAsync(() => usersApi.list(), [usersApi])
  const operators = (list.data?.users ?? []).filter((u) => u.role === 'operator' && !u.banned && u.username).map((u) => u.username!)
  // someone it names who's no longer an operator stays listed, to take off
  const names = [...new Set([...operators, ...runners])].sort()
  const toggle = (name: string, on: boolean) => onChange(on ? [...runners, name].sort() : runners.filter((x) => x !== name))
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Who may run it</legend>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">Admins always may. Name no one and every operator may; name some and only they may. Viewers never run runbooks.</p>
      {list.error && <ErrorBox error={list.error} onRetry={list.reload} />}
      {!list.data && list.loading && <Spinner />}
      {list.data && !names.length && <p className="text-xs text-zinc-500 dark:text-zinc-400">There are no operators yet.</p>}
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {names.map((name) => (
          <label key={name} className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={runners.includes(name)} onChange={(e) => toggle(name, e.target.checked)} className="accent-accent-600" aria-label={`${name} may run it`} />
            <span className="font-mono text-xs">{name}</span>
            {!operators.includes(name) && list.data && <span className="text-xs text-amber-700 dark:text-amber-400">(not an operator)</span>}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

/** Runbooks from a YAML file, shown before they're imported: what's new, what it replaces, what's wrong. */
function ImportModal({ existing, onClose, onDone }: { existing: string[]; onClose: () => void; onDone: () => void }) {
  const api = useRunbooksApi()!
  const [text, setText] = useState('')
  const [replace, setReplace] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const read = text.trim() ? readRunbookFile(text) : null
  const entries = read && 'entries' in read ? read.entries : []
  const bad = entries.filter((e) => 'error' in e).length
  const taken = entries.filter((e) => !('error' in e) && existing.includes(e.name)).length
  const ready = entries.length > 0 && !bad && (!taken || replace)
  const pick = async (file: File | undefined) => {
    if (file) setText(await file.text())
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.import(entries.flatMap((x) => ('runbook' in x ? [x.runbook] : [])), replace)
      onDone()
      onClose()
    } catch (err) {
      setError(err as Error)
      setBusy(false)
    }
  }
  return (
    <Modal open onClose={onClose} title="Import runbooks" wide>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">A YAML file as <strong>Export</strong> writes it: <code className="font-mono text-xs">runbooks:</code> with a list, or one runbook. Each is checked like the editor checks it, and they're imported together or not at all.</p>
        <Field label="File">
          <input type="file" accept=".yaml,.yml,.json,application/yaml,text/yaml" onChange={(e) => void pick(e.target.files?.[0])} aria-label="Runbook file" className="block text-sm" />
        </Field>
        <Field label="Or paste it">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} spellCheck={false} aria-label="Runbook YAML" placeholder={'runbooks:\n  - name: Restart a service\n    steps:\n      - fun: service.restart\n        target: web-01\n        args: nginx'} className="w-full rounded-lg border border-zinc-200 bg-white p-2 font-mono text-xs focus:border-accent-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-900" />
        </Field>
        {read && 'error' in read && <p className="text-sm text-red-700 dark:text-red-400">{read.error}</p>}
        {entries.length > 0 && (
          <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 text-sm dark:divide-zinc-800 dark:border-zinc-800" aria-label="Runbooks in the file">
            {entries.map((x, i) => (
              <li key={i} className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2" aria-label={x.name}>
                <span className="font-medium">{x.name}</span>
                {'error' in x ? (
                  <span className="text-xs text-red-700 dark:text-red-400">{x.error}</span>
                ) : existing.includes(x.name) ? (
                  <Badge tone="amber">replaces the one with this name</Badge>
                ) : (
                  <Badge tone="green">new, {x.runbook.steps.length} {x.runbook.steps.length === 1 ? 'step' : 'steps'}</Badge>
                )}
              </li>
            ))}
          </ul>
        )}
        {taken > 0 && (
          <label className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} className="accent-accent-600" /> Replace the {taken === 1 ? 'runbook' : `${taken} runbooks`} with the same name
          </label>
        )}
        {bad > 0 && <p className="text-xs text-zinc-500 dark:text-zinc-400">Fix {bad === 1 ? 'the runbook' : `the ${bad} runbooks`} marked in red in the file first.</p>}
        {error && <ErrorBox error={error} />}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" icon={<Upload className="size-4" />} loading={busy} disabled={!ready}>
            Import {entries.length > 0 && !bad ? `${entries.length} ${entries.length === 1 ? 'runbook' : 'runbooks'}` : ''}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
