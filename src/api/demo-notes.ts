import { recordDemoAudit } from './demo-audit'
import type { MinionNote, minionNotes } from './server'

/*
 * The demo's notes on minions, kept in the browser like the server would keep them, with a couple
 * to start from. Each change is in the demo's audit log.
 */

const delay = <T>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 80))
const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString()

const notes: Record<string, MinionNote> = {
  'db-01': { note: 'Owner: DBA team (olga). Restart only in the Tuesday window; replicas follow it.', updatedBy: 'olga', updatedAt: ago(30) },
  'cache-01': { note: 'Being replaced by cache-02 — powered off on purpose, don’t chase it.', updatedBy: 'pipo', updatedAt: ago(5) },
}

export const demoMinionNotes: typeof minionNotes = {
  list: () => delay({ notes: { ...notes } }),
  save: (minion, text) => {
    const note = text.trim()
    if (note.length > 2000) return Promise.reject(new Error('A note is at most 2000 characters'))
    if ((notes[minion]?.note ?? '') === note) return delay({ note: notes[minion] ?? null })
    if (note) notes[minion] = { note, updatedBy: 'demo', updatedAt: new Date().toISOString() }
    else delete notes[minion]
    recordDemoAudit({ username: 'demo', client: 'console', fun: note ? 'minions.note' : 'minions.note_removed', target: minion, targetType: 'list', args: note ? JSON.stringify({ note }) : null, outcome: 'ok' })
    return delay({ note: notes[minion] ?? null })
  },
}
