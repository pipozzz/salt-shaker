import { describe, expect, it } from 'vitest'
import { LoopDelay } from './loop'

describe('LoopDelay', () => {
  it('reports how long the event loop was held up, once per reading', async () => {
    const loop = new LoopDelay(20)
    loop.start()
    await new Promise((r) => setTimeout(r, 50))
    expect(loop.takeMax()).toBeLessThan(0.05)
    const until = performance.now() + 150
    while (performance.now() < until) {
      // hold the loop, like a long synchronous write
    }
    await new Promise((r) => setTimeout(r, 50))
    const held = loop.takeMax()
    loop.stop()
    expect(held).toBeGreaterThan(0.1)
    expect(held).toBeLessThan(0.5)
    expect(loop.takeMax()).toBe(0)
  })
})
