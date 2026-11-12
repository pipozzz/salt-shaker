/* Arguments as typed on the Run page, shared by the browser and the server (runbooks). */

/**
 * Splits CLI-style input like `web 'two words' test=True pkgs='["a","b"]'` into Salt
 * positional args and kwargs. Values are coerced like the salt CLI does for the common
 * cases: booleans, integers, and JSON lists/objects.
 */
export function parseArgs(input: string) {
  const tokens = input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
  const arg: unknown[] = []
  const kwarg: Record<string, unknown> = {}
  for (const raw of tokens) {
    const eq = raw.indexOf('=')
    const isKw = eq > 0 && /^[A-Za-z_]\w*$/.test(raw.slice(0, eq))
    const value = coerce(unquote(isKw ? raw.slice(eq + 1) : raw))
    if (isKw) kwarg[raw.slice(0, eq)] = value
    else arg.push(value)
  }
  return { arg, kwarg }
}

/** Strips one pair of surrounding quotes; inner quotes (e.g. in JSON) are kept. */
function unquote(s: string) {
  const m = s.match(/^(["'])([\s\S]*)\1$/)
  return m ? m[2] : s
}

function coerce(s: string): unknown {
  if (s === 'True' || s === 'true') return true
  if (s === 'False' || s === 'false') return false
  if (/^-?\d+$/.test(s)) return Number(s)
  if (/^[[{]/.test(s)) {
    try {
      return JSON.parse(s)
    } catch {
      // not JSON after all: pass the string through
    }
  }
  return s
}
