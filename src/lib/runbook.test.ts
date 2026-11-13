import { describe, expect, it } from 'vitest'
import { continuedSteps, continueFrom, mayRun, readRunbook, resolveRunbook, type RunbookInput } from './runbook'

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
    expect(readRunbook({ ...restart, name: '  Restart a service safely ' })).toEqual({ ...restart, runners: [] })
    expect(readRunbook({ ...restart, steps: [] })).toEqual({ error: 'Add at least one step' })
    expect(readRunbook({ ...restart, params: [{ name: 'Host' }] })).toMatchObject({ error: expect.stringContaining("can't be a parameter name") })
    expect(readRunbook({ ...restart, params: [restart.params[0], restart.params[0]] })).toEqual({ error: 'The parameter host is there twice' })
    expect(readRunbook({ ...restart, steps: [{ ...restart.steps[0], fun: 'rm -rf' }] })).toEqual({ error: 'Step 1: the function is a name like state.apply' })
    expect(readRunbook({ ...restart, steps: [{ ...restart.steps[0], args: '{{port}}' }] })).toEqual({ error: "Step 1 uses {{port}}, which isn't a parameter" })
    // steps for a failure come last, after at least one that always runs
    const undo = { ...restart.steps[0], name: 'Undo', onFailure: true }
    expect(readRunbook({ ...restart, steps: [...restart.steps, undo] })).toMatchObject({ steps: [{}, {}, { name: 'Undo', onFailure: true }] })
    expect(readRunbook({ ...restart, steps: [undo, ...restart.steps] })).toEqual({ error: 'Step 2 runs every time, so it comes before the steps for a failure' })
    expect(readRunbook({ ...restart, steps: [undo] })).toEqual({ error: 'Add a step that runs every time, not only on a failure' })
    // a step may ask before it runs
    expect(readRunbook({ ...restart, steps: [restart.steps[0], { ...restart.steps[1], confirm: true }] })).toMatchObject({ steps: [{}, { name: 'Restart', confirm: true }] })
    expect(resolveRunbook({ ...restart, steps: [{ ...restart.steps[1], confirm: true }] }, { host: 'a' })).toMatchObject({ steps: [{ confirm: true }] })
    // the operators who may run it: trimmed, once each, in order
    expect(readRunbook({ ...restart, runners: [' olga', 'bob', 'olga', ''] })).toMatchObject({ runners: ['bob', 'olga'] })
    expect(readRunbook({ ...restart, runners: ['a b'] })).toEqual({ error: '"a b" isn\'t a username' })
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

  it('continues a stopped run at the step that stopped it, keeping what ran before', () => {
    const base = { fun: 'test.ping', target: '*', targetType: 'glob', arg: [], kwarg: {}, continueOnFailure: false }
    const steps = [
      { ...base, name: 'A', status: 'done', jid: 'j1', fromRun: 3 },
      { ...base, name: 'B', status: 'failed', jid: 'j2', continueOnFailure: true },
      { ...base, name: 'C', status: 'failed', jid: 'j3', failed: ['web-02'], error: 'x' },
      { ...base, name: 'D', status: 'skipped' },
    ]
    expect(continueFrom({ status: 'stopped', steps })).toBe(2)
    // the steps for a failure that ran after it don't count, and run again with the rest
    const undo = { ...base, name: 'Undo', status: 'done', jid: 'j4', onFailure: true }
    expect(continueFrom({ status: 'stopped', steps: [...steps, undo] })).toBe(2)
    expect(continuedSteps([...steps, undo], 2, 7).at(-1)).toEqual({ ...base, name: 'Undo', status: 'waiting', onFailure: true })
    expect(continueFrom({ status: 'rejected', steps })).toBeNull()
    expect(continueFrom({ status: 'running', steps })).toBeNull()
    // the last step may fail and did: nothing is left to run
    expect(continueFrom({ status: 'stopped', steps: steps.slice(0, 2) })).toBeNull()
    expect(continuedSteps(steps, 2, 7)).toEqual([
      { ...steps[0], fromRun: 3 },
      { ...steps[1], fromRun: 7 },
      { ...base, name: 'C', status: 'waiting' },
      { ...base, name: 'D', status: 'waiting' },
    ])
  })

  it('lets admins run any runbook, and operators the ones that name none or them', () => {
    expect(mayRun({ runners: ['dba'] }, { role: 'admin', username: 'ada' })).toBe(true)
    expect(mayRun({ runners: [] }, { role: 'operator', username: 'olga' })).toBe(true)
    expect(mayRun({}, { role: 'operator', username: 'olga' })).toBe(true)
    expect(mayRun({ runners: ['dba'] }, { role: 'operator', username: 'olga' })).toBe(false)
    expect(mayRun({ runners: ['dba', 'olga'] }, { role: 'operator', username: 'olga' })).toBe(true)
    expect(mayRun({ runners: [] }, { role: 'viewer', username: 'vic' })).toBe(false)
  })
})
