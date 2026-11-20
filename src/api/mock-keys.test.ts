import { describe, expect, it } from 'vitest'
import { MockTransport } from './mock'
import type { KeyList } from './types'

// the demo answers the per-list key calls the way a master does
describe('demo key calls by list', () => {
  const t = new MockTransport()
  const wheel = (fun: string, kw: Record<string, unknown> = {}) => t.call({ client: 'wheel', fun, ...kw }) as Promise<{ data: { return: unknown } }>
  const lists = async () => (await wheel('key.list_all')).data.return as KeyList

  it('moves only the key named, and only from a list it may take', async () => {
    const before = await lists()
    const pending = before.minions_pre[0]
    expect(pending).toBeTruthy()

    // without include_accepted, an accepted key can't be rejected
    const accepted = before.minions[0]
    await wheel('key.reject_dict', { match: { minions: [accepted] } })
    expect((await lists()).minions).toContain(accepted)

    // naming the wrong list touches nothing
    await wheel('key.delete_dict', { match: { minions_denied: [pending] } })
    expect((await lists()).minions_pre).toContain(pending)

    await wheel('key.reject_dict', { match: { minions_pre: [pending] } })
    let now = await lists()
    expect(now.minions_pre).not.toContain(pending)
    expect(now.minions_rejected).toContain(pending)

    await wheel('key.accept_dict', { match: { minions_rejected: [pending] }, include_rejected: true })
    now = await lists()
    expect(now.minions_rejected).not.toContain(pending)
    expect(now.minions).toContain(pending)

    await wheel('key.delete_dict', { match: { minions: [pending] } })
    now = await lists()
    expect([...now.minions, ...now.minions_pre, ...now.minions_rejected, ...now.minions_denied]).not.toContain(pending)
  })
})
