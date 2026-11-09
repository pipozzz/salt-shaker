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
  await expect(page.getByRole('cell', { name: 'web-01', exact: true })).toBeVisible()
  // the fleet breakdown filters the table
  await page.getByRole('button', { name: /3006\.9/ }).click()
  await expect(page.getByRole('cell', { name: 'mon-01', exact: true })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'web-01', exact: true })).toBeHidden()
})

test('minion filters are kept in the URL and survive going back', async ({ page }) => {
  await openDemo(page)
  await page.getByPlaceholder('Filter by id, OS, IP or role…').fill('db')
  await page.getByRole('button', { name: /3007\.1/ }).click()
  await expect(page).toHaveURL(/q=db/)
  await expect(page).toHaveURL(/facet=salt%3A3007\.1/)
  await page.getByRole('cell', { name: 'db-01', exact: true }).click()
  await expect(page).toHaveURL(/\/minions\/db-01$/)
  await page.goBack()
  await expect(page.getByPlaceholder('Filter by id, OS, IP or role…')).toHaveValue('db')
  await expect(page.getByText('Salt: 3007.1')).toBeVisible()
  await expect(page.getByRole('cell', { name: 'db-01', exact: true })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'web-01', exact: true })).toBeHidden()
})

test('a minion page keeps its tab and filter in the URL and links back to the filtered list', async ({ page }) => {
  await openDemo(page)
  await page.getByPlaceholder('Filter by id, OS, IP or role…').fill('db')
  await page.getByRole('cell', { name: 'db-01', exact: true }).click()
  await page.getByRole('button', { name: 'Pillar', exact: true }).click()
  await expect(page).toHaveURL(/tab=pillar/)
  await page.getByPlaceholder('Filter keys…').fill('postgres')
  await expect(page).toHaveURL(/\/minions\/db-01\?tab=pillar&q=postgres$/)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Pillar', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByPlaceholder('Filter keys…')).toHaveValue('postgres')
  await page.getByRole('main').getByRole('link', { name: 'Minions' }).click()
  await expect(page).toHaveURL(/:\d+\/\?(demo=&)?q=db$/)
  await expect(page.getByRole('cell', { name: 'web-01', exact: true })).toBeHidden()
})

test('minions picked on the list open Run with them as a list target', async ({ page }) => {
  await openDemo(page)
  await page.getByPlaceholder('Filter by id, OS, IP or role…').fill('web')
  await page.getByRole('checkbox', { name: /Select all \d+ shown minions/ }).check()
  // the selection survives a different filter
  await page.getByPlaceholder('Filter by id, OS, IP or role…').fill('db-01')
  await page.getByRole('checkbox', { name: 'Select db-01' }).check()
  await expect(page.getByText(/^\d+ selected/)).toContainText('(2 not shown by the filter)')
  await page.getByRole('button', { name: 'Run on selected' }).click()
  await expect(page).toHaveURL(/\/run\?/)
  await expect(page.getByLabel('Target')).toHaveValue('db-01,web-01,web-02')
  await expect(page.getByText('3 minions:')).toBeVisible()
})

test('the filtered minions list downloads as CSV', async ({ page }) => {
  await openDemo(page)
  await page.getByPlaceholder('Filter by id, OS, IP or role…').fill('web')
  await expect(page.getByRole('cell', { name: 'db-01', exact: true })).toBeHidden()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export CSV' }).click()
  const file = await download
  expect(file.suggestedFilename()).toMatch(/^minions-\d{4}-\d{2}-\d{2}\.csv$/)
  const lines = (await readFile(await file.path(), 'utf8')).trim().split('\r\n')
  expect(lines[0]).toMatch(/^minion,status,os,os_release,kernel,ipv4,cpus,memory_mb,virtual,roles,salt_version/)
  expect(lines.slice(1).map((l) => l.split(',')[0])).toEqual(expect.arrayContaining(['web-01', 'web-02']))
  expect(lines.some((l) => l.startsWith('db-01,'))).toBe(false)
})

test('vulnerabilities are listed by severity and a fix opens Run with the upgrade', async ({ page }) => {
  await openDemo(page)
  // the minions list links each minion's counts to its Vulnerabilities tab
  await page.getByRole('row', { name: /db-01/ }).getByRole('link', { name: /1 critical/ }).click()
  await expect(page).toHaveURL(/\/minions\/db-01\?tab=vulns$/)
  await expect(page.getByRole('cell', { name: 'postgresql-15 15.8-0+deb12u1', exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'All minions →' }).click()
  await expect(page).toHaveURL(/\/vulnerabilities\?view=minions&q=db-01$/)
  await page.getByRole('button', { name: 'Show vulnerabilities on db-01' }).click()
  await expect(page.getByRole('cell', { name: 'postgresql-15 15.8-0+deb12u1', exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'By vulnerability' }).click()
  await page.getByPlaceholder('Filter by CVE, package or text…').fill('')
  await page.getByRole('button', { name: 'High', exact: true }).click()
  await expect(page).toHaveURL(/severity=high/)
  await expect(page.getByRole('row', { name: /DEMO-2026-0144/ })).toBeVisible()
  await expect(page.getByRole('row', { name: /DEMO-2026-0101/ })).toBeHidden()

  // the export has the page's filters
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export CSV' }).click()
  const file = await download
  expect(file.suggestedFilename()).toMatch(/^vulnerabilities-\d{4}-\d{2}-\d{2}\.csv$/)
  const lines = (await readFile(await file.path(), 'utf8')).trim().split('\r\n')
  expect(lines[0]).toBe('minion,os,package,installed_packages,installed_version,vulnerability,cves,severity,cvss,fixed_in,summary,inventory_at')
  expect(lines.slice(1).map((l) => l.split(',').slice(0, 3).join(','))).toEqual([
    'mon-01,rocky 9.4,sudo',
    'web-01,ubuntu 24.04,nginx',
    'web-01,ubuntu 24.04,sudo',
    'web-02,ubuntu 24.04,nginx',
    'web-02,ubuntu 24.04,sudo',
    'worker-01,ubuntu 22.04,sudo',
  ])

  await page.getByRole('button', { name: 'All', exact: true }).click()
  // the filter lives in the URL, so the box is checked once the address changes
  await page.getByLabel('Fix available').click()
  await expect(page).toHaveURL(/fix=1/)
  await expect(page.getByLabel('Fix available')).toBeChecked()
  await expect(page.getByRole('row', { name: /DEMO-2025-0912/ })).toBeHidden()
  await page.getByRole('button', { name: 'Show minions with DEMO-2026-0144' }).click()
  // web-02 already has the fixed nginx, so only web-01 gets the upgrade
  await page.getByRole('link', { name: 'Upgrade on 1 minion' }).click()
  await expect(page).toHaveURL(/\/run\?/)
  await expect(page.getByLabel('Target')).toHaveValue('web-01')
  await expect(page.getByLabel('Function')).toHaveValue('pkg.install')
  await expect(page.getByLabel('Arguments')).toHaveValue(`pkgs='["nginx","nginx-common"]' only_upgrade=True`)
})

test('run previews the target and shows results', async ({ page }) => {
  await openDemo(page, '/run?tgt=web-*&fun=test.ping')
  await expect(page.getByText('2 minions:')).toBeVisible()
  await page.getByRole('button', { name: 'Run on 2' }).click()
  await expect(page.getByText('2/2 returned')).toBeVisible()
})

test('results can be grouped by identical output', async ({ page }) => {
  await openDemo(page, '/run?tgt=*&fun=test.version')
  await page.getByRole('button', { name: 'Run on 6' }).click()
  await page.getByRole('button', { name: /By output \(2\)/ }).click()
  await expect(page.getByText(/2 different outputs from 5 minions/)).toBeVisible()
  const biggest = page.getByRole('button', { name: /4 minions/ })
  await expect(biggest).toContainText('3007.1')
  await expect(page.getByRole('button', { name: /1 minion\b/ })).toContainText('mon-01')
  // the odd one out becomes the next target
  await page.getByRole('button', { name: 'Run on these 1' }).click()
  await expect(page.getByLabel('Target')).toHaveValue('mon-01')
  await expect(page.getByText('1 minion:')).toBeVisible()
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

test('patches flag the upgrades that fix known vulnerabilities', async ({ page }) => {
  await openDemo(page, '/patches')
  await page.getByRole('button', { name: 'Scan for updates' }).click()
  const openssl = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'openssl', exact: true }) })
  await expect(openssl.getByRole('link', { name: /Critical/ })).toHaveAttribute('href', '/vulnerabilities?q=DEMO-2026-0101')
  await expect(page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'tzdata', exact: true }) })).toBeVisible()
  await page.getByText(/Fixes vulnerabilities \(\d+\)/).click()
  await expect(openssl).toBeVisible()
  await expect(page.getByRole('cell', { name: 'tzdata', exact: true })).toHaveCount(0)

  // one click upgrades only those, only where they fix something
  await page.getByRole('button', { name: 'Upgrade security fixes' }).click()
  await expect(page.getByRole('heading', { name: 'Upgrade security fixes on 2 minions' })).toBeVisible()
  await expect(page.getByText('pkg.install pkgs=["libssl3t64","nginx","openssl"] only_upgrade=True')).toBeVisible()
  await page.getByRole('button', { name: 'Upgrade 2 minions' }).click()
  await expect(page.getByText('2/2 returned')).toBeVisible()
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

test('a saved target is offered on Run and in the command palette', async ({ page }) => {
  await openDemo(page, '/run?tgt=web-*')
  await page.getByTitle('Save this target').click()
  await page.getByPlaceholder('Name, e.g. webservers').fill('webservers')
  await page.getByRole('button', { name: 'Save target' }).click()
  await page.reload()
  await page.getByLabel('Target').fill('db-01')
  await page.getByRole('button', { name: 'webservers', exact: true }).click()
  await expect(page.getByLabel('Target')).toHaveValue('web-*')
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByPlaceholder(/Jump to a page or minion/).fill('webservers')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/tgt=web-\*/)
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
