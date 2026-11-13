import { parse, stringify } from 'yaml'
import { MAX_IMPORT, readRunbook, type RunbookInput } from './runbook'

/*
 * Runbooks as a YAML file, to keep in git or carry to another Salt Shaker: export writes the parts
 * an admin wrote (no ids, authors or dates), import reads them back through the same checks as the
 * editor. The server checks them again when they're imported.
 */

/** One runbook as it goes in the file: only what was set. */
function fileShape(rb: RunbookInput) {
  return {
    name: rb.name,
    ...(rb.description ? { description: rb.description } : {}),
    ...(rb.params.length ? { params: rb.params } : {}),
    steps: rb.steps.map((s) => ({
      name: s.name,
      target: s.target,
      ...(s.targetType !== 'glob' ? { targetType: s.targetType } : {}),
      fun: s.fun,
      ...(s.args ? { args: s.args } : {}),
      ...(s.continueOnFailure ? { continueOnFailure: true } : {}),
      ...(s.confirm ? { confirm: true } : {}),
      ...(s.onFailure ? { onFailure: true } : {}),
      ...(s.batchSize ? { batchSize: s.batchSize } : {}),
    })),
    ...(rb.runners?.length ? { runners: rb.runners } : {}),
  }
}

/** The file: a header, then the runbooks in a list. */
export function runbooksToYaml(rbs: RunbookInput[]) {
  return `# Salt Shaker runbooks: import them on Runbooks → Import…\n${stringify({ runbooks: rbs.map(fileShape) }, { lineWidth: 0 })}`
}

export const fileName = (rbs: RunbookInput[]) =>
  rbs.length === 1 ? `runbook-${rbs[0].name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'runbook'}.yaml` : 'runbooks.yaml'

/** YAML reads `args: 8080` or `default: yes` as numbers and booleans; the editor's fields are text. */
const asText = (o: unknown, keys: string[]) => {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return o
  const r = { ...(o as Record<string, unknown>) }
  for (const k of keys) if (typeof r[k] === 'number' || typeof r[k] === 'boolean') r[k] = String(r[k])
  return r
}

function textFields(raw: Record<string, unknown>) {
  return {
    ...raw,
    ...(Array.isArray(raw.params) ? { params: raw.params.map((p) => asText(p, ['name', 'label', 'default'])) } : {}),
    ...(Array.isArray(raw.steps) ? { steps: raw.steps.map((s) => asText(s, ['name', 'target', 'fun', 'args', 'batchSize'])) } : {}),
  }
}

export type FileEntry = { name: string; runbook: RunbookInput } | { name: string; error: string }

/**
 * What a file holds: `runbooks:` with a list, a bare list, or one runbook. Each entry is checked
 * like the editor checks it; a file that isn't YAML, or holds nothing, is an error of its own.
 */
export function readRunbookFile(text: string): { entries: FileEntry[] } | { error: string } {
  let doc: unknown
  try {
    doc = parse(text, { maxAliasCount: 10 })
  } catch (e) {
    return { error: `It isn't YAML: ${(e as Error).message.split('\n')[0]}` }
  }
  const obj = doc && typeof doc === 'object' && !Array.isArray(doc) ? (doc as Record<string, unknown>) : null
  const items = Array.isArray(doc) ? doc : Array.isArray(obj?.runbooks) ? (obj.runbooks as unknown[]) : obj && 'steps' in obj ? [obj] : null
  if (!items) return { error: 'There are no runbooks in it: expected "runbooks:" with a list' }
  if (!items.length) return { error: 'The list of runbooks is empty' }
  if (items.length > MAX_IMPORT) return { error: `At most ${MAX_IMPORT} runbooks at a time` }
  const seen = new Set<string>()
  const entries = items.map((item, i): FileEntry => {
    const raw = item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>) : {}
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : `Runbook ${i + 1}`
    const rb = readRunbook(textFields(raw))
    if ('error' in rb) return { name, error: rb.error }
    if (seen.has(rb.name)) return { name, error: 'It is in the file twice' }
    seen.add(rb.name)
    return { name: rb.name, runbook: rb }
  })
  return { entries }
}
