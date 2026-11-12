/** Email channels: who receives them. Shared by the server and the demo. */

const ADDRESS = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/
const MAX_RECIPIENTS = 20

/** "a@x.com, b@y.com" (commas, semicolons or spaces) as a clean list, or a sentence saying what's wrong. */
export function readRecipients(raw: string): { to: string[] } | { error: string } {
  const to = [...new Set(raw.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))]
  if (!to.length) return { error: 'Add at least one email address' }
  const bad = to.find((a) => !ADDRESS.test(a))
  if (bad) return { error: `"${bad}" is not an email address` }
  if (to.length > MAX_RECIPIENTS) return { error: `At most ${MAX_RECIPIENTS} addresses per channel; use a mailing list for more` }
  return { to }
}
