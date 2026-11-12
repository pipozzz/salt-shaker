import { describe, expect, it } from 'vitest'
import { readRunbook, resolveRunbook, type RunbookInput } from './runbook'

const restart: RunbookInput = {
  name: 'Restart a service safely',
  description: '',
  params: [
    { name: 'host', label: 'Minion', default: '', required: true },
    { name: 'service', label: 'Service', default: 'nginx', required: true },
  ],
  steps: [
    { name: 'Check config', fun: 'cmd.run', target: '{{host}}', targetType: 'glob', args: "'{{service}} -t'", continueOnFailure: false },
    { name: 'Restart', fun: 'service.restart', target: '{{host}}', targetType: 'glob', args: 'name={{service}}', continueOnFailure: false },
  ],
}

describe('runbooks', () => {
  it('reads what an admin enters, and says what is wrong', () => {
    expect(readRunbook({ ...restart, name: '  Restart a service safely ' })).toEqual(restart)
    expect(readRunbook({ ...restart, steps: [] })).toEqual({ error: 'Add at least one step' })
    expect(readRunbook({ ...restart, params: [{ name: 'Host' }] })).toMatchObject({ error: expect.stringContaining("can't be a parameter name") })
    expect(readRunbook({ ...restart, params: [restart.params[0], restart.params[0]] })).toEqual({ error: 'The parameter host is there twice' })
    expect(readRunbook({ ...restart, steps: [{ ...restart.steps[0], fun: 'rm -rf' }] })).toEqual({ error: 'Step 1: the function is a name like state.apply' })
    expect(readRunbook({ ...restart, steps: [{ ...restart.steps[0], args: '{{port}}' }] })).toEqual({ error: "Step 1 uses {{port}}, which isn't a parameter" })
    // a step without a name is numbered
    expect(readRunbook({ ...restart, steps: [{ ...restart.steps[0], name: '' }] })).toMatchObject({ steps: [{ name: 'Step 1' }] })
  })

  it('fills the values in, with defaults, and requires what has none', () => {
    const r = resolveRunbook(restart, { host: 'web-01' })
    expect(r).toEqual({
      values: { host: 'web-01', service: 'nginx' },
      steps: [
        { name: 'Check config', fun: 'cmd.run', target: 'web-01', targetType: 'glob', arg: ['nginx -t'], kwarg: {}, continueOnFailure: false },
        { name: 'Restart', fun: 'service.restart', target: 'web-01', targetType: 'glob', arg: [], kwarg: { name: 'nginx' }, continueOnFailure: false },
      ],
    })
    expect(resolveRunbook(restart, {})).toEqual({ error: 'Minion is required' })
    expect(resolveRunbook(restart, { host: 'a\nb' })).toEqual({ error: 'Minion has to fit on one line' })
  })

  it("keeps a value inside its argument: it can't add arguments of its own", () => {
    const r = resolveRunbook(restart, { host: 'web-01', service: 'nginx test=True extra' })
    expect('steps' in r && r.steps[1].kwarg).toEqual({ name: 'nginx test=True extra' })
    expect('steps' in r && r.steps[1].arg).toEqual([])
  })
})
