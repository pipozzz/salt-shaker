import type { RunbookParam } from './runbook'

/*
 * What a runbook webhook takes from a call, shared by the server and the demo.
 */

/**
 * The values a call sets: from its JSON body, at the top level or under "params", and only those
 * the webhook lets it set. Anything else in the body is ignored, so a tool's own payload fits.
 */
export function readCallValues(body: string, fromRequest: string[]): { values: Record<string, string> } | { error: string } {
  if (!body.trim()) return { values: {} }
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return { error: 'The body is not JSON' }
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { error: 'The body is not a JSON object' }
  const obj = json as Record<string, unknown>
  const src = obj.params && typeof obj.params === 'object' && !Array.isArray(obj.params) ? (obj.params as Record<string, unknown>) : obj
  const values: Record<string, string> = {}
  for (const name of fromRequest) {
    const v = src[name]
    if (v === undefined || v === null) continue
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return { error: `"${name}" must be text` }
    const s = String(v)
    if (s.length > 500) return { error: `"${name}" is too long` }
    values[name] = s
  }
  return { values }
}

/** A webhook's settings, cleaned: the values it sets and those a call may set, all the runbook's. */
export function readHookSettings(params: RunbookParam[], given: unknown, from: unknown): { params: Record<string, string>; fromRequest: string[] } | { error: string } {
  const names = new Set(params.map((p) => p.name))
  const fixed: Record<string, string> = {}
  if (given && typeof given === 'object') for (const [k, v] of Object.entries(given)) if (names.has(k) && typeof v === 'string' && v.trim()) fixed[k] = v.slice(0, 500)
  const fromRequest = Array.isArray(from) ? [...new Set(from.filter((n): n is string => typeof n === 'string' && names.has(n)))] : []
  const missing = params.find((p) => p.required && !fixed[p.name] && !p.default && !fromRequest.includes(p.name))
  if (missing) return { error: `${missing.label || missing.name} is required: set it here or let the call set it` }
  return { params: fixed, fromRequest }
}

/** A body to start from when trying a webhook: the values a call may set, empty. */
export const sampleBody = (fromRequest: string[]) => JSON.stringify(Object.fromEntries(fromRequest.map((n) => [n, ''])), null, 2)
