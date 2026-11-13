import { describe, expect, it } from 'vitest'
import type { RunbookInput } from './runbook'
import { fileName, readRunbookFile, runbooksToYaml } from './runbook-file'

const restart: RunbookInput = {
  name: 'Restart a service',
  description: 'Checks the config first',
  params: [{ name: 'host', label: 'Minion', default: '', required: true }],
  steps: [
    { name: 'Check config', fun: 'cmd.run', target: '{{host}}', targetType: 'glob', args: "'nginx -t'", continueOnFailure: false },
    { name: 'Restart', fun: 'service.restart', target: 'G@role:web and {{host}}', targetType: 'compound', args: 'nginx', continueOnFailure: false, confirm: true },
    { name: 'Start it', fun: 'service.start', target: '{{host}}', targetType: 'glob', args: 'nginx', continueOnFailure: false, onFailure: true },
  ],
  runners: ['olga'],
}

describe('runbook files', () => {
  it('writes only what was set, and reads it back as it was', () => {
    const text = runbooksToYaml([restart, { name: 'Ping', description: '', params: [], steps: [{ name: 'Ping', fun: 'test.ping', target: '*', targetType: 'glob', args: '', continueOnFailure: false }], runners: [] }])
    expect(text).toMatch(/^# Salt Shaker runbooks/)
    expect(text).not.toContain('continueOnFailure')
    expect(text).not.toContain('runners: []')
    expect(readRunbookFile(text)).toEqual({
      entries: [
        { name: 'Restart a service', runbook: restart },
        { name: 'Ping', runbook: { name: 'Ping', description: '', params: [], steps: [{ name: 'Ping', fun: 'test.ping', target: '*', targetType: 'glob', args: '', continueOnFailure: false }], runners: [] } },
      ],
    })
    expect(fileName([restart])).toBe('runbook-restart-a-service.yaml')
  })

  it('takes a list or one runbook, numbers and yes as text, and says what is wrong with each', () => {
    const one = readRunbookFile('name: Port\nsteps:\n  - fun: cmd.run\n    target: "*"\n    args: 8080\n')
    expect(one).toMatchObject({ entries: [{ name: 'Port', runbook: { steps: [{ args: '8080' }] } }] })
    expect(readRunbookFile('- name: A\n  steps: []\n- name: B\n  steps: [{fun: test.ping, target: "*"}]\n- name: B\n  steps: [{fun: test.ping, target: "*"}]\n')).toEqual({
      entries: [
        { name: 'A', error: 'Add at least one step' },
        { name: 'B', runbook: expect.objectContaining({ name: 'B' }) },
        { name: 'B', error: 'It is in the file twice' },
      ],
    })
    expect(readRunbookFile('runbooks: [')).toMatchObject({ error: expect.stringMatching(/^It isn't YAML/) })
    expect(readRunbookFile('hello: world')).toEqual({ error: 'There are no runbooks in it: expected "runbooks:" with a list' })
    expect(readRunbookFile('runbooks: []')).toEqual({ error: 'The list of runbooks is empty' })
  })
})
