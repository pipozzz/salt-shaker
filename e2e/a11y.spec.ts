import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

// WCAG 2.1 A/AA checks (contrast, labels, roles…) on the main pages, in both themes.
// Serious and critical findings fail the build.
const PAGES: Array<[string, (p: Page) => Promise<void>]> = [
  ['login', async (p) => {
    await p.goto('/')
    await expect(p.getByRole('button', { name: 'Demo' })).toBeVisible()
  }],
  ['minions', async (p) => {
    await p.goto('/?demo')
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
