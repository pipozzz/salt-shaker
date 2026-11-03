import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'

/** Opens the demo; ?demo signs in to the mock master directly. */
async function openDemo(page: Page, path = '/') {
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}demo`)
  await expect(page.getByRole('complementary').getByText('Demo', { exact: true })).toBeVisible()
}

test('minions overview shows the fleet and flags old Salt versions', async ({ page }) => {
  await openDemo(page)
  await expect(page.getByRole('heading', { name: 'Minions' })).toBeVisible()
  await expect(page.getByText('1 minion is behind the master (3007.1)')).toBeVisible()
  await expect(page.getByRole('cell', { name: 'web-01' })).toBeVisible()
  // the fleet breakdown filters the table
  await page.getByRole('button', { name: /3006\.9/ }).click()
  await expect(page.getByRole('cell', { name: 'mon-01' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'web-01' })).toBeHidden()
})

test('minion filters are kept in the URL and survive going back', async ({ page }) => {
  await openDemo(page)
  await page.getByPlaceholder('Filter by id, OS, IP or role…').fill('db')
  await page.getByRole('button', { name: /3007\.1/ }).click()
  await expect(page).toHaveURL(/q=db/)
  await expect(page).toHaveURL(/facet=salt%3A3007\.1/)
  await page.getByRole('cell', { name: 'db-01' }).click()
  await expect(page).toHaveURL(/\/minions\/db-01$/)
  await page.goBack()
  await expect(page.getByPlaceholder('Filter by id, OS, IP or role…')).toHaveValue('db')
  await expect(page.getByText('Salt: 3007.1')).toBeVisible()
  await expect(page.getByRole('cell', { name: 'db-01' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'web-01' })).toBeHidden()
})

test('run previews the target and shows results', async ({ page }) => {
  await openDemo(page, '/run?tgt=web-*&fun=test.ping')
  await expect(page.getByText('2 minions:')).toBeVisible()
  await page.getByRole('button', { name: 'Run on 2' }).click()
  await expect(page.getByText('2/2 returned')).toBeVisible()
})

test('risky commands on many minions need the count typed', async ({ page }) => {
  await openDemo(page, "/run?tgt=*&fun=cmd.run&args='uptime'")
  await page.getByRole('button', { name: 'Run on 6' }).click()
  const dialog = page.getByRole('heading', { name: 'Confirm run' }).locator('xpath=ancestor::div[contains(@class,"shadow-2xl")]')
  const confirm = dialog.getByRole('button', { name: 'Run on 6' })
  await expect(confirm).toBeDisabled()
  await dialog.getByRole('textbox').fill('6')
  await expect(confirm).toBeEnabled()
  await confirm.click()
  await expect(page.getByText(/\d\/6 returned/)).toBeVisible()
})

test('compliance check groups minions', async ({ page }) => {
  await openDemo(page, '/compliance')
  await page.getByRole('button', { name: 'Check now' }).click()
  await expect(page.getByRole('button', { name: /Remediate \d+ drifted/ })).toBeVisible()
  await expect(page.getByText('Checked')).toBeVisible()
})

test('command palette jumps to a minion', async ({ page }) => {
  await openDemo(page)
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByPlaceholder(/Jump to a page or minion/).fill('db-01')
  // minions load when the palette opens; wait until the match is offered
  await expect(page.getByRole('button', { name: 'db-01' })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/minions\/db-01$/)
  await expect(page.getByRole('heading', { name: 'db-01' })).toBeVisible()
  // reopening starts with an empty query
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.getByPlaceholder(/Jump to a page or minion/)).toHaveValue('')
})

test('enroll dialog starts clean every time it opens', async ({ page }) => {
  await openDemo(page, '/keys')
  await page.getByRole('button', { name: 'Enroll minion' }).click()
  await page.getByPlaceholder('web-03').fill('edge-99')
  await expect(page.getByText('sh /tmp/bootstrap-salt.sh -i edge-99')).toBeVisible()
  await page.getByRole('button', { name: 'Close' }).click()
  await page.getByRole('button', { name: 'Enroll minion' }).click()
  await expect(page.getByPlaceholder('web-03')).toHaveValue('')
})

test('accepting a pending key moves it to accepted', async ({ page }) => {
  await openDemo(page, '/keys')
  const pending = page.locator('li', { hasText: 'worker-02' })
  await pending.getByRole('button', { name: 'Accept' }).click()
  await expect(page.getByRole('heading', { name: /Accepted\s*7/ })).toBeVisible()
})

test('pillar view picks the first minion by default', async ({ page }) => {
  await openDemo(page, '/files')
  await page.getByRole('button', { name: 'Pillar by minion' }).click()
  await expect(page.getByRole('combobox')).toHaveValue('cache-01')
  await expect(page.getByText('ntp_servers:')).toBeVisible()
})

test('orchestrate selects the first orchestration and dry-runs it', async ({ page }) => {
  await openDemo(page, '/orchestrate')
  await expect(page.getByText('salt://orch/deploy.sls')).toBeVisible()
  await page.getByRole('button', { name: 'Dry-run orchestration' }).click()
  await expect(page.getByText('succeeded')).toBeVisible()
  await expect(page.locator('li', { hasText: 'apply_common' }).getByText('salt.state')).toBeVisible()
})

test('failed minions can be retried and results downloaded', async ({ page }) => {
  await openDemo(page, '/run?tgt=web-*&fun=nope.missing')
  await page.getByRole('button', { name: 'Run on 2' }).click()
  await expect(page.getByText('2/2 returned')).toBeVisible()

  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download results as CSV' }).click()
  const file = await download
  expect(file.suggestedFilename()).toMatch(/^job-\d+\.csv$/)
  const csv = await readFile(await file.path(), 'utf8')
  expect(csv).toContain("web-01,failed,,,,,'nope.missing' is not available.")

  // change the form, then retry: it targets the failed minions with the original function
  await page.getByLabel('Function').fill('test.ping')
  await page.getByRole('button', { name: 'Retry 2 failed' }).click()
  await expect(page.getByLabel('Target')).toHaveValue('web-01,web-02')
  await expect(page.getByLabel('Match by')).toHaveValue('list')
  await expect(page.getByLabel('Function')).toHaveValue('nope.missing')
})

test('running jobs are listed and can be stopped', async ({ page }) => {
  await openDemo(page, '/run?tgt=web-*&fun=test.sleep&args=120')
  await page.getByRole('button', { name: 'Run on 2' }).click()
  await page.getByRole('link', { name: 'Jobs' }).click()
  const running = page.getByRole('listitem').filter({ hasText: 'still running on web-01, web-02' })
  await expect(running).toBeVisible()
  await running.getByRole('button', { name: 'Stop' }).click()
  await page.getByRole('button', { name: 'Stop on 2' }).click()
  await expect(page.getByText('No jobs are running.')).toBeVisible()
})

test('a job can be stopped from its page', async ({ page }) => {
  await openDemo(page, '/run?tgt=web-*&fun=test.sleep&args=120')
  await page.getByRole('button', { name: 'Run on 2' }).click()
  await page.getByRole('link', { name: 'Open job' }).click()
  await expect(page.getByText('Still running on web-01, web-02')).toBeVisible()
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await page.getByRole('button', { name: 'Stop on 2' }).click()
  await expect(page.getByText('No return from: web-01, web-02')).toBeVisible()
})
