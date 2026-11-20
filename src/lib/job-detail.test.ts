import { beforeEach, describe, expect, it, vi } from 'vitest'
import { history } from '../api/server'
import { SaltError } from '../api/types'
import { jobReturns } from './job-detail'

vi.mock('../api/server', () => ({ history: { job: vi.fn() }, parseStoredArgs: () => [] }))

const job = vi.mocked(history.job)
const ret = (minion: string, r: unknown) => ({ jid: '1', minion, ret: r, retcode: 0, success: true, returnedAt: '' })

describe('jobReturns', () => {
  const salt = { lookupJid: vi.fn(async () => ({ 'web-01': 'from the master' }) as Record<string, unknown>) }
  beforeEach(() => {
    job.mockReset()
    salt.lookupJid.mockClear()
  })

  it("reads a running job's returns from the server's history, not the master", async () => {
    job.mockResolvedValue({ job: {} as never, returns: [ret('web-01', true), ret('db-01', { a: 1 })] })
    expect(await jobReturns(salt, true, '1')).toEqual({ 'web-01': true, 'db-01': { a: 1 } })
    expect(salt.lookupJid).not.toHaveBeenCalled()
  })

  it('asks the master when the server has not recorded the job', async () => {
    job.mockRejectedValue(new SaltError('Not in history', 404))
    expect(await jobReturns(salt, true, '1')).toEqual({ 'web-01': 'from the master' })
  })

  it('asks the master when the server kept only the size of a return', async () => {
    job.mockResolvedValue({ job: {} as never, returns: [ret('web-01', { _truncated: true, bytes: 900_000 })] })
    expect(await jobReturns(salt, true, '1')).toEqual({ 'web-01': 'from the master' })
  })

  it('asks the master without a server', async () => {
    expect(await jobReturns(salt, false, '1')).toEqual({ 'web-01': 'from the master' })
    expect(job).not.toHaveBeenCalled()
  })

  it("passes on the server's other errors", async () => {
    job.mockRejectedValue(new SaltError('Not signed in', 401))
    await expect(jobReturns(salt, true, '1')).rejects.toMatchObject({ status: 401 })
    expect(salt.lookupJid).not.toHaveBeenCalled()
  })
})
