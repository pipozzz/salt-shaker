import { describe, expect, it } from 'vitest'
import { formatArgs, parseArgs, SaltApi } from './salt'
import type { Lowstate, Transport } from './types'

describe('parseArgs', () => {
  it('splits positional args and kwargs', () => {
    expect(parseArgs('webserver test=True')).toEqual({ arg: ['webserver'], kwarg: { test: true } })
  })

  it('keeps quoted values with spaces together', () => {
    expect(parseArgs("'systemctl status nginx' cwd=/tmp")).toEqual({ arg: ['systemctl status nginx'], kwarg: { cwd: '/tmp' } })
    expect(parseArgs('name="hello world"')).toEqual({ arg: [], kwarg: { name: 'hello world' } })
  })

  it('coerces booleans and integers', () => {
    expect(parseArgs('False 42 -3 timeout=10')).toEqual({ arg: [false, 42, -3], kwarg: { timeout: 10 } })
  })

  it('parses JSON lists and objects without mangling inner quotes', () => {
    expect(parseArgs(`pkgs='["openssl","tzdata"]'`).kwarg).toEqual({ pkgs: ['openssl', 'tzdata'] })
    expect(parseArgs(`pillar='{"version": "1.2"}'`).kwarg).toEqual({ pillar: { version: '1.2' } })
  })

  it('leaves things that only look like JSON as strings', () => {
    expect(parseArgs("'[not json'").arg).toEqual(['[not json'])
  })

  it('does not treat a = inside a value as a kwarg', () => {
    expect(parseArgs("'a=b c'").arg).toEqual(['a=b c'])
    expect(parseArgs('--opt=1').arg).toEqual(['--opt=1'])
  })

  it('handles empty input', () => {
    expect(parseArgs('   ')).toEqual({ arg: [], kwarg: {} })
  })
})

describe('formatArgs', () => {
  it('renders job Arguments back to CLI form', () => {
    // shape from jobs.list_jobs on Salt 3007
    expect(formatArgs(['common', { __kwarg__: true, test: true }])).toBe('common test=True')
    expect(formatArgs(['uptime -p'])).toBe("'uptime -p'")
    expect(formatArgs([])).toBe('')
  })

  it('round-trips through parseArgs', () => {
    const args = ['two words', 7, { __kwarg__: true, test: false, pkgs: ['a', 'b'] }]
    const parsed = parseArgs(formatArgs(args).replace(`pkgs=["a","b"]`, `pkgs='["a","b"]'`))
    expect(parsed).toEqual({ arg: ['two words', 7], kwarg: { test: false, pkgs: ['a', 'b'] } })
  })
})

/** A transport that answers lowstates from a handler, for testing SaltApi without a master. */
function fakeTransport(handler: (low: Lowstate) => unknown): Transport {
  return {
    login: async () => ({ token: 't', expire: 0, user: 'u', eauth: 'pam' }),
    logout: async () => undefined,
    call: async (low) => handler(low),
    events: () => () => undefined,
  }
}

describe('SaltApi', () => {
  it('learns the master clock offset from wheel replies to place jids in time', async () => {
    // master runs in UTC; its jid shows 17:29:18 local == 17:29:18Z
    const api = new SaltApi(
      fakeTransport(() => ({ data: { jid: '20261101172918420721', _stamp: '2026-11-01T17:29:18.453286', return: {}, success: true } })),
      't',
      () => undefined,
    )
    await api.keys()
    expect(api.jidDate('20261101172918420721')?.toISOString()).toBe('2026-11-01T17:29:18.000Z')
  })

  it('accounts for a master running ahead of UTC', async () => {
    // master in UTC+2: local 19:00 while _stamp (always UTC) says 17:00
    const api = new SaltApi(
      fakeTransport(() => ({ data: { jid: '20261101190000000000', _stamp: '2026-11-01T17:00:00.100000', return: {}, success: true } })),
      't',
      () => undefined,
    )
    await api.keys()
    expect(api.jidDate('20261101193000000000')?.toISOString()).toBe('2026-11-01T17:30:00.000Z')
  })

  it('unwraps the {outputter, data} envelope lookup_jid uses for state jobs', async () => {
    const api = new SaltApi(fakeTransport(() => ({ outputter: 'highstate', data: { 'web-01': { 'x_|-y_|-z_|-w': { result: true } } } })), 't', () => undefined)
    expect(Object.keys(await api.lookupJid('1'))).toEqual(['web-01'])
  })

  it('treats an empty key.gen_accept reply as "already exists"', async () => {
    const api = new SaltApi(fakeTransport(() => ({ data: { return: {}, success: true } })), 't', () => undefined)
    await expect(api.genAccept('web-01')).rejects.toThrow(/already exists/)
  })

  it('finds the runner return stored under <master>_master', async () => {
    const api = new SaltApi(
      fakeTransport(() => ({ master_master: { fun: 'runner.state.orchestrate', return: { retcode: 0 }, success: true } })),
      't',
      () => undefined,
    )
    expect(await api.runnerResult('1')).toMatchObject({ return: { retcode: 0 } })
  })

  it('reports a still-running runner job as null', async () => {
    const api = new SaltApi(fakeTransport(() => ({})), 't', () => undefined)
    expect(await api.runnerResult('1')).toBeNull()
  })
})
