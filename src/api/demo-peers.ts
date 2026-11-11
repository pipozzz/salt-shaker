import { recordDemoAudit } from './demo-audit'
import { demoMinionStatus } from './mock'
import type { InstanceSummary, Peer, peers, PeerStatus } from './server'

/*
 * The demo's other masters: a production instance in another region, and a lab that doesn't
 * answer. Their addresses are made up, so the switcher only shows them.
 */

const delay = <T>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 150))
let nextId = 3
const list: Array<Peer & { summary?: InstanceSummary; error?: string }> = [
  {
    id: 1,
    name: 'prod-us',
    url: 'https://salt-us.example.com',
    summary: { name: 'prod-us', version: '1.20.0', url: 'https://salt-us.example.com', minions: { accepted: 48, notAnswering: 2 }, pendingKeys: 0, failedJobs: 1, vulns: { critical: 0, high: 6 }, waitingApproval: 1 },
  },
  { id: 2, name: 'lab', url: 'https://salt-lab.example.com', error: 'No answer within 5 seconds' },
]

function self(): InstanceSummary {
  const { up, down } = demoMinionStatus()
  return { name: 'demo', version: 'demo', url: window.location.origin, minions: { accepted: up.length + down.length, notAnswering: down.length }, pendingKeys: 2, failedJobs: 3, vulns: { critical: 3, high: 7 }, waitingApproval: 1 }
}

export const demoPeers: typeof peers = {
  list: () => delay({ self: { name: 'demo' }, peers: list.map(({ id, name, url }) => ({ id, name, url })).sort((a, b) => a.name.localeCompare(b.name)) }),
  summary: () => delay(self()),
  status: () => delay({ peers: [...list].sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ id: p.id, name: p.name, url: p.url, ...(p.summary ? { summary: p.summary } : { error: p.error ?? 'Unknown' }) }) as PeerStatus) }),
  add: ({ name, url, token }) => {
    if (!name.trim()) return Promise.reject(new Error('Give it a name (60 characters at most)'))
    if (!/^https?:\/\/[^/]+/.test(url.trim())) return Promise.reject(new Error('The address has to be an http(s) URL of a Salt Shaker, like https://salt-eu.example.com'))
    if (!token.trim().startsWith('ss_')) return Promise.reject(new Error('Paste an API token made on that instance (it starts with ss_)'))
    // nothing leaves the browser in the demo: a new instance is "reachable" with an empty fleet
    const id = nextId++
    const clean = url.trim().replace(/\/+$/, '')
    list.push({ id, name: name.trim(), url: clean, summary: { name: name.trim(), version: '1.20.0', url: clean, minions: { accepted: 0, notAnswering: 0 }, pendingKeys: 0, failedJobs: 0, vulns: null, waitingApproval: 0 } })
    recordDemoAudit({ username: 'demo', client: 'admin', fun: 'peer.add', target: `${name.trim()} (${clean})`, outcome: 'ok' })
    return delay({ id })
  },
  remove: (id) => {
    const i = list.findIndex((p) => p.id === id)
    if (i >= 0) {
      recordDemoAudit({ username: 'demo', client: 'admin', fun: 'peer.remove', target: `${list[i].name} (${list[i].url})`, outcome: 'ok' })
      list.splice(i, 1)
    }
    return delay({})
  },
}
