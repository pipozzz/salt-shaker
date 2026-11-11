import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

// WCAG 2.1 A/AA checks (contrast, labels, roles…) on the main pages, in both themes.
// Serious and critical findings fail the build.
const PAGES: Array<[string, (p: Page) => Promise<void>]> = [
  ['login', async (p) => {
    await p.goto('/')
    await expect(p.getByRole('button', { name: 'Demo' })).toBeVisible()
  }],
  ['overview', async (p) => {
    await p.goto('/?demo')
    await expect(p.getByText('1 minion not responding')).toBeVisible()
  }],
  ['minions', async (p) => {
    await p.goto('/minions')
    await expect(p.getByRole('cell', { name: 'web-01', exact: true })).toBeVisible()
  }],
  ['enrollment', async (p) => {
    await p.goto('/keys')
    await expect(p.getByText('Pending approval')).toBeVisible()
  }],
  ['run with results', async (p) => {
    await p.goto('/run?tgt=web-*&fun=test.ping')
    await p.getByRole('button', { name: 'Run on 2' }).click()
    await expect(p.getByText('2/2 returned')).toBeVisible()
  }],
  ['compliance with results', async (p) => {
    await p.goto('/compliance')
    await p.getByRole('button', { name: 'Check now' }).click()
    await expect(p.getByRole('button', { name: /Remediate \d+ drifted/ })).toBeVisible()
  }],
  ['patches', async (p) => {
    await p.goto('/patches')
    await p.getByRole('button', { name: 'Scan for updates' }).click()
    await expect(p.getByText('Need updates')).toBeVisible()
  }],
  ['orchestrate', async (p) => {
    await p.goto('/orchestrate')
    await expect(p.getByText('salt://orch/deploy.sls')).toBeVisible()
  }],
  ['states', async (p) => {
    await p.goto('/files')
    await expect(p.getByText('Maps states to minions')).toBeVisible()
  }],
  ['vulnerabilities', async (p) => {
    await p.goto('/vulnerabilities')
    await expect(p.getByRole('img', { name: /^Vulnerabilities over/ })).toBeVisible()
    await p.getByRole('button', { name: 'Show minions with DEMO-2026-0101' }).click()
    await expect(p.getByRole('button', { name: 'Accept risk…' })).toBeVisible()
  }],
  ['installed packages', async (p) => {
    await p.goto('/vulnerabilities?view=packages&q=ssl')
    await expect(p.getByText(/versions? on \d+ minions?/)).toBeVisible()
  }],
  ['query with results', async (p) => {
    await p.goto('/query')
    await p.getByRole('button', { name: /Authorized SSH keys/ }).click()
    await p.getByRole('button', { name: 'Run query' }).click()
    await expect(p.getByText(/osquery is not installed/)).toBeVisible()
    await p.getByLabel('Group identical rows').check()
  }],
  ['minion packages', async (p) => {
    await p.goto('/minions/db-01?tab=packages')
    await expect(p.getByText(/\d+ packages · debian 12/)).toBeVisible()
  }],
  ['branch preview', async (p) => {
    await p.goto('/compliance/preview')
    await p.getByLabel('Target').fill('web-*')
    await p.getByRole('button', { name: 'Preview' }).click()
    await expect(p.getByText('2 of 2 minions would differ')).toBeVisible()
  }],
  ['api tokens', async (p) => {
    await p.goto('/tokens')
    await expect(p.getByText('gitlab: deploy pipeline')).toBeVisible()
  }],
  ['change', async (p) => {
    await p.goto('/changes/1')
    await expect(p.getByText('Batch 2')).toBeVisible()
  }],
  ['changes', async (p) => {
    await p.goto('/changes')
    await expect(p.getByText('Waiting for approval (1)')).toBeVisible()
  }],
  ['schedules', async (p) => {
    await p.goto('/schedules')
    await p.getByText('What changed in the last run').click()
  }],
  ['notifications', async (p) => {
    await p.goto('/notifications')
    await expect(p.getByText('Ops Slack')).toBeVisible()
  }],
  ['audit log', async (p) => {
    await p.goto('/audit')
    await expect(p.getByRole('button', { name: /vic denied/ })).toBeVisible()
  }],
  ['users', async (p) => {
    await p.goto('/users')
    await expect(p.getByText('Vic Viewer')).toBeVisible()
  }],
  ['system', async (p) => {
    await p.goto('/system')
    await expect(p.getByText('Connected').first()).toBeVisible()
  }],
  ['command palette', async (p) => {
    await p.goto('/jobs')
    await p.keyboard.press('ControlOrMeta+k')
    await expect(p.getByPlaceholder(/Jump to a page/)).toBeVisible()
  }],
]

for (const scheme of ['light', 'dark'] as const) {
  test(`no serious accessibility issues (${scheme})`, async ({ page }) => {
    test.setTimeout(120_000)
    await page.emulateMedia({ colorScheme: scheme })
    const problems: string[] = []
    for (const [name, open] of PAGES) {
      await open(page)
      const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
      for (const v of violations.filter((x) => x.impact === 'serious' || x.impact === 'critical')) {
        problems.push(`${name}: ${v.id} (${v.nodes.length}×) ${v.help} → ${v.nodes[0]?.target.join(' ')}`)
      }
    }
    expect(problems, problems.join('\n')).toEqual([])
  })
}
