import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'

/** Opens the demo; ?demo signs in to the mock master directly. Most tests start at the minions list. */
async function openDemo(page: Page, path = '/minions') {
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}demo`)
  await expect(page.getByRole('complementary').getByText('Demo', { exact: true })).toBeVisible()
}

test('the overview shows how the fleet is doing and what needs attention', async ({ page }) => {
  await openDemo(page, '/')
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()
  const tile = (label: string) => page.getByRole('link', { name: new RegExp(label) })
  await expect(tile('Minions responding')).toContainText('5/6')
  await expect(tile('Drifted or failing')).toContainText('3')
  await expect(tile('Critical & high vulns')).toContainText('6 with a fix')
  await expect(tile('Failed jobs, last day')).toBeVisible()

  // worst first, each pointing where it gets fixed
  const items = page.getByRole('listitem').filter({ has: page.getByRole('link', { name: /See them|Upgrade|Review keys|Remediate|See jobs/ }) })
  await expect(items.first()).toContainText('1 minion not responding')
  await expect(items.first()).toContainText('cache-01')
  await page.getByRole('link', { name: 'Remediate' }).click()
  await expect(page).toHaveURL(/\/compliance$/)

  // a stat opens its page
  await page.getByRole('link', { name: 'Overview' }).click()
  // once the minions have answered, the tile leads to the ones that didn't
  await expect(tile('Minions responding')).toContainText('1 not responding')
  await tile('Minions responding').click()
  await expect(page).toHaveURL(/\/minions\?status=down$/)
  await expect(page.getByRole('cell', { name: 'cache-01', exact: true })).toBeVisible()
})

test('an old link to the minions list with filters still opens it', async ({ page }) => {
  await openDemo(page, '/?q=db')
  await expect(page).toHaveURL(/\/minions\?q=db$/)
  await expect(page.getByPlaceholder('Filter by id, OS, IP or role…')).toHaveValue('db')
})

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
  await expect(page).toHaveURL(/\/minions\?(demo=&)?q=db$/)
  await expect(page.getByRole('cell', { name: 'web-01', exact: true })).toBeHidden()
})

test('two minions picked on the list can be compared', async ({ page }) => {
  await openDemo(page)
  await page.getByRole('checkbox', { name: 'Select web-01' }).check()
  await page.getByRole('checkbox', { name: 'Select db-01' }).check()
  await page.getByRole('button', { name: 'Compare' }).click()
  await expect(page).toHaveURL(/\/minions\/compare\?a=/)
  await expect(page.getByRole('row', { name: /^os Ubuntu Debian$|^os Debian Ubuntu$/ })).toBeVisible()
  await expect(page.getByRole('row', { name: /^postgresql-15/ })).toContainText('missing')
  // names and addresses are set apart until asked for
  await expect(page.getByRole('row', { name: /^id / })).toHaveCount(0)
  await page.getByLabel('Show names, addresses and ids').check()
  await expect(page.getByRole('row', { name: /^id / })).toBeVisible()
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

test('the vulnerability trend shows each day on hover', async ({ page }) => {
  await openDemo(page, '/vulnerabilities')
  const chart = page.getByRole('img', { name: /^Vulnerabilities over \d+ days/ })
  await expect(chart).toBeVisible()
  const box = (await chart.boundingBox())!
  await page.mouse.move(box.x + box.width * 0.62, box.y + box.height / 2)
  await expect(page.getByText(/\d+\/6 minions affected/)).toBeVisible()
})

test('installed packages can be searched across the fleet', async ({ page }) => {
  await openDemo(page, '/vulnerabilities')
  await page.getByRole('button', { name: 'Installed packages' }).click()
  await expect(page.getByText('Search the installed packages')).toBeVisible()
  // the installed package name finds its source package
  await page.getByPlaceholder(/Search installed packages/).fill('libssl')
  await expect(page.getByText('2 versions on 3 minions')).toBeVisible()
  const ubuntu = page.getByRole('row', { name: /3\.0\.13-0ubuntu3\.4/ })
  await expect(ubuntu).toContainText('libssl3t64, openssl')
  await expect(ubuntu).toContainText('2web-01web-02')
  await expect(page).toHaveURL(/view=packages&q=libssl/)
  await ubuntu.getByRole('link', { name: 'openssl', exact: true }).click()
  await expect(page).toHaveURL(/\/vulnerabilities\?q=openssl$/)
  await expect(page.getByRole('row', { name: /DEMO-2026-0101/ })).toBeVisible()
})

test('accepting the risk of a vulnerability takes it out of the list until withdrawn', async ({ page }) => {
  await openDemo(page, '/vulnerabilities')
  await page.getByRole('button', { name: 'Show minions with DEMO-2025-0912' }).click()
  await page.getByRole('button', { name: 'Accept risk…' }).click()
  await expect(page.getByRole('button', { name: 'Accept risk', exact: true })).toBeDisabled()
  await page.getByPlaceholder(/The service isn't exposed/).fill('Only local users, none untrusted')
  await page.getByRole('combobox').last().selectOption({ label: '7 days' })
  await page.getByRole('button', { name: 'Accept risk', exact: true }).click()
  await expect(page.getByRole('button', { name: /minions with DEMO-2025-0912/ })).toHaveCount(0)

  // a week or less to go is flagged
  await page.getByRole('button', { name: 'Accepted (1) · 1 expiring' }).click()
  await expect(page).toHaveURL(/view=accepted/)
  const row = page.getByRole('row', { name: /DEMO-2025-0912/ })
  await expect(row).toContainText('Only local users, none untrusted')
  await expect(row).toContainText('demo')
  await expect(row.getByText('expires in 7 days')).toBeVisible()
  await row.getByRole('button', { name: 'Withdraw' }).click()
  await expect(page.getByText('No accepted vulnerabilities')).toBeVisible()
  await page.getByRole('button', { name: 'By vulnerability' }).click()
  await expect(page.getByRole('button', { name: 'Show minions with DEMO-2025-0912' })).toBeVisible()
})

test('osquery answers in one table, and installs where it is missing', async ({ page }) => {
  await openDemo(page, '/query')
  await page.getByRole('button', { name: /Listening ports/ }).click()
  await page.getByRole('button', { name: 'Run query' }).click()
  await expect(page.getByRole('row', { name: /web-01 nginx 443/ })).toBeVisible()
  await expect(page.getByText(/osquery is not installed on worker-01/)).toBeVisible()

  await page.getByPlaceholder('Filter rows…').fill('postgres')
  await expect(page.getByRole('row', { name: /db-01 postgres 5432/ })).toBeVisible()
  await expect(page.getByRole('row', { name: /nginx/ })).toHaveCount(0)
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export CSV' }).click()
  const lines = (await readFile(await (await download).path(), 'utf8')).trim().split('\r\n')
  expect(lines).toEqual(['minion,name,port,protocol,address,path', 'db-01,postgres,5432,6,10.0.2.21,/usr/lib/postgresql/15/bin/postgres'])

  await page.getByPlaceholder('Filter rows…').fill('')

  // only one SELECT runs
  await page.getByLabel('SQL').fill('DELETE FROM users')
  await expect(page.getByText('Only SELECT queries can run here')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Run query' })).toBeDisabled()
  await page.getByRole('button', { name: /Listening ports/ }).click()

  await page.getByRole('button', { name: 'Install osquery…' }).click()
  await page.getByRole('button', { name: 'Install on 1 minion' }).click()
  await expect(page.getByText('Installed on 1 of 1.')).toBeVisible()
  await page.getByRole('button', { name: 'Run the query again' }).click()
  await expect(page.getByRole('row', { name: /worker-01 sshd 22/ })).toBeVisible()
  await expect(page.getByText(/osquery is not installed/)).toHaveCount(0)
})

test('grouped osquery rows put what only a few minions have first', async ({ page }) => {
  await openDemo(page, '/query')
  await page.getByRole('button', { name: /Authorized SSH keys/ }).click()
  await page.getByRole('button', { name: 'Run query' }).click()
  await expect(page.getByRole('button', { name: 'Run query' })).toBeVisible()
  await page.getByLabel('Group identical rows').check()
  await expect(page.getByText('5 rows from 4 of 6 minions, 2 distinct')).toBeVisible()
  const rows = page.getByRole('row')
  await expect(rows.nth(1)).toContainText('1web-02tmpadmin')
  await expect(rows.nth(2)).toContainText('4db-01mon-01web-01+1deploy')

  // the results are still there after looking at a minion
  await rows.nth(1).getByRole('link', { name: 'web-02' }).click()
  await expect(page).toHaveURL(/\/minions\/web-02$/)
  await page.goBack()
  await expect(page.getByText('5 rows from 4 of 6 minions, 2 distinct')).toBeVisible()
  await expect(page.getByText('Query edited since')).toHaveCount(0)
})

test("a minion page lists what's installed on it", async ({ page }) => {
  await openDemo(page, '/minions/db-01?tab=packages')
  await expect(page.getByText(/\d+ packages · debian 12/)).toBeVisible()
  const pg = page.getByRole('row', { name: /postgresql-15/ })
  await expect(pg).toContainText('15.8-0+deb12u1')
  await expect(pg).toContainText('1 vuln, 1 with a fix')
  await page.getByLabel('With vulnerabilities').check()
  await expect(page.getByRole('row', { name: /^bash/ })).toHaveCount(0)
  await page.getByLabel('Filter packages').fill('curl')
  await expect(page.getByRole('row', { name: /curl/ })).toBeVisible()
  await expect(pg).toHaveCount(0)
  await page.getByRole('row', { name: /curl/ }).getByRole('link').click()
  await expect(page).toHaveURL(/\/minions\/db-01\?tab=vulns$/)
})

test('a minion page opens Query on that minion', async ({ page }) => {
  await openDemo(page, '/minions/db-01')
  await page.getByRole('button', { name: 'Query', exact: true }).click()
  await expect(page).toHaveURL(/\/query$/)
  await expect(page.getByLabel('Target')).toHaveValue('db-01')
  await page.getByRole('button', { name: 'Run query' }).click()
  await expect(page.getByText(/rows? from 1 of 1 minion/)).toBeVisible()
})

test('a query opens from ⌘K or a link, and its results sort by column', async ({ page }) => {
  await openDemo(page)
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByPlaceholder(/Jump to a page or minion/).fill('ssh keys')
  await page.getByRole('button', { name: /Authorized SSH keys/ }).click()
  await expect(page).toHaveURL(/\/query$/)
  await expect(page.getByLabel('SQL')).toHaveValue(/FROM users u CROSS JOIN authorized_keys/)

  // a shared link brings the query and the target
  await page.goto(`/query?${new URLSearchParams({ sql: 'SELECT name, port FROM listening_ports;', tgt: 'web-*', tgt_type: 'glob' })}`)
  await expect(page.getByLabel('SQL')).toHaveValue('SELECT name, port FROM listening_ports;')
  await expect(page.getByLabel('Target')).toHaveValue('web-*')
  await page.getByRole('button', { name: 'Run query' }).click()
  await expect(page.getByRole('button', { name: 'Run query' })).toBeVisible()

  // numbers sort as numbers: 22 before 443, and 8000 last
  await page.getByRole('button', { name: 'port', exact: true }).click()
  const ports = page.getByRole('row').locator('td:nth-child(3)')
  await expect(ports).toHaveText(['22', '22', '80', '80', '443', '443', '8000'])
  await page.getByRole('button', { name: 'port', exact: true }).click()
  await expect(ports.first()).toHaveText('8000')
})

test('the demo has schedules, and a query can be watched from the Query page', async ({ page }) => {
  await openDemo(page, '/schedules')
  await expect(page.getByText('Nightly compliance')).toBeVisible()
  await expect(page.getByText('+1 on 1 minion')).toBeVisible()
  await page.getByText('What changed in the last run').click()
  await expect(page.getByText(/^web-02: \+ .*username=tmpadmin$/)).toBeVisible()
  // its runs are real jobs of the simulated master
  await page.getByRole('link', { name: /updates available \(5 minions with 6 packages to update\)/ }).last().click()
  await expect(page).toHaveURL(/\/jobs\/\d{20}$/)
  await expect(page.getByText('pkg.list_upgrades').first()).toBeVisible()
  await expect(page.getByText('schedule:Weekly patch scan').first()).toBeVisible()

  // Watch… on the Query page opens a new osquery schedule with that query and target
  await page.goto('/query')
  await page.getByRole('button', { name: /Listening ports/ }).click()
  await page.getByRole('button', { name: 'Watch…' }).click()
  await expect(page).toHaveURL(/\/schedules/)
  await expect(page.getByRole('heading', { name: 'New schedule' })).toBeVisible()
  await expect(page.getByLabel('Name')).toHaveValue('Listening ports')
  await expect(page.getByLabel('What to run')).toHaveValue('osquery')
  await expect(page.getByLabel('Query', { exact: true })).toHaveValue(/FROM listening_ports/)

  // the same rule as the server: one SELECT only
  await page.getByLabel('Query', { exact: true }).fill('DELETE FROM users')
  await expect(page.getByText('Only SELECT queries can run here')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Create schedule' })).toBeDisabled()
  await page.getByLabel('Start from the library').selectOption({ label: 'Authorized SSH keys' })
  await page.getByRole('button', { name: 'Create schedule' }).click()
  await expect(page.getByText('Listening ports', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Run now' }).first().click()
})

test('the demo has notification channels to try, and JSON webhooks get a signing secret', async ({ page }) => {
  await openDemo(page, '/notifications')
  await expect(page.getByText('Ops Slack')).toBeVisible()
  await page.getByRole('button', { name: 'Test' }).first().click()
  await expect(page.getByText('Test message sent')).toBeVisible()

  await page.getByRole('button', { name: 'Add channel' }).click()
  await page.getByLabel('Name').fill('SIEM')
  await page.getByLabel('Format').selectOption('webhook')
  await page.getByLabel('Webhook URL').fill('https://siem.example.com/ingest')
  await page.getByRole('button', { name: 'Add channel' }).last().click()
  await expect(page.getByRole('heading', { name: 'Signing secret for SIEM' })).toBeVisible()
  await expect(page.getByLabel('Signing secret')).toHaveText(/^whsec_[\w-]{32}$/)
  await page.getByRole('button', { name: 'Done' }).click()
  const siem = page.getByRole('listitem').filter({ hasText: 'SIEM' })
  await expect(siem.getByText('signed', { exact: true })).toBeVisible()

  // a new secret, after saying the old one stops working
  await siem.getByRole('button', { name: 'New secret' }).click()
  await expect(page.getByText('the old one stops working right away')).toBeVisible()
  await page.getByRole('button', { name: 'Make a new secret' }).click()
  await expect(page.getByRole('heading', { name: 'Signing secret for SIEM' })).toBeVisible()
})

test('a runbook runs step by step and stops at the step that fails', async ({ page }) => {
  await openDemo(page, '/runbooks')
  // listed by name: Restart a service safely comes first
  await expect(page.getByRole('heading', { name: 'Restart a service safely' })).toBeVisible()
  await page.getByRole('button', { name: 'Run…' }).first().click()
  await page.getByLabel('Minions').fill('web-*')
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page).toHaveURL(/\/runbooks\/runs\/\d+$/)
  const steps = page.getByRole('list', { name: 'Steps' })
  await expect(steps.getByRole('listitem', { name: 'Check the configuration: done' })).toBeVisible()
  // nginx won't restart on web-02 in the demo: the run stops there and skips the rest
  await expect(steps.getByRole('listitem', { name: 'Restart: failed' })).toContainText('failed: web-02')
  await expect(steps.getByRole('listitem', { name: 'Make sure it runs: skipped' })).toBeVisible()
  // then its step for a failure runs, and the run ends as the restart said
  await expect(steps.getByRole('listitem', { name: /^Start it again: / })).toContainText('if it fails')
  await expect(page.getByText('stopped', { exact: true })).toBeVisible()
  await expect(page.getByText('Restart failed on 1 minion: web-02', { exact: true })).toBeVisible()
  // the failed step shows what each minion returned; the others open on request
  await expect(steps.getByRole('listitem', { name: 'Restart: failed' })).toContainText('Job for nginx.service failed: the unit is not available.')
  const check = steps.getByRole('listitem', { name: 'Check the configuration: done' })
  await check.getByRole('button', { name: 'Show the output of Check the configuration' }).click()
  await expect(check).toContainText('nginx -t: executed on web-01')

  // run it again with the same values, or continue from the step that stopped it
  await page.getByRole('button', { name: 'Run again' }).click()
  await expect(page.getByRole('textbox', { name: 'Minions' })).toHaveValue('web-*')
  await page.getByRole('button', { name: 'Cancel' }).click()
  const stoppedUrl = page.url()
  const stoppedId = stoppedUrl.split('/').pop()
  await page.getByRole('button', { name: 'Continue from step 2' }).click()
  await expect(page).not.toHaveURL(stoppedUrl)
  await expect(steps.getByRole('listitem', { name: 'Check the configuration: done' })).toContainText(`in run #${stoppedId}`)
  await expect(steps.getByRole('listitem', { name: /^Restart: (running|failed|done)$/ })).toBeVisible()

  // admins write them; a step can only use the values it asks for
  await page.getByRole('link', { name: 'Runbooks', exact: true }).first().click()
  await page.getByRole('button', { name: 'New runbook' }).click()
  await page.getByLabel('Runbook name').fill('Reboot')
  await page.getByLabel('Step 1 target').fill('{{host}}')
  await page.getByLabel('Step 1 function').fill('system.reboot')
  await page.getByRole('button', { name: 'Create runbook' }).click()
  await expect(page.getByText("Step 1 uses {{host}}, which isn't a parameter")).toBeVisible()
  await page.getByRole('button', { name: 'Add a value' }).click()
  await page.getByLabel('Value 1 name').fill('host')
  // only olga, and admins, may run it
  await page.getByRole('checkbox', { name: 'olga may run it' }).check()
  await page.getByRole('button', { name: 'Create runbook' }).click()
  await expect(page.getByText('Reboot', { exact: true })).toBeVisible()
  await expect(page.getByText('Run by olga and admins')).toHaveCount(2)
})

test('a runbook waits before a step that asks first, until someone lets it go on', async ({ page }) => {
  await openDemo(page, '/runbooks')
  await page.getByRole('button', { name: 'Run…' }).nth(1).click()
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page).toHaveURL(/\/runbooks\/runs\/\d+$/)
  const steps = page.getByRole('list', { name: 'Steps' })
  await expect(steps.getByRole('listitem', { name: 'Apply: waiting to go on' })).toContainText('asks first')
  await expect(page.getByText('Step 3, Apply, waits for you to go on.', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Go on with step 3' }).click()
  await expect(steps.getByRole('listitem', { name: /^Apply: (running|done|failed)$/ })).toContainText('let go on by demo')
})

test('a schedule runs a runbook, and its runbook stays while it does', async ({ page }) => {
  await openDemo(page, '/schedules')
  const web = page.getByRole('listitem').filter({ hasText: 'Web highstate' })
  await expect(web.getByRole('link', { name: 'Sync and apply the highstate' })).toBeVisible()
  await expect(web.getByText('target=web-*')).toBeVisible()
  await web.getByRole('button', { name: 'Run now' }).click()
  await expect(web.getByRole('link', { name: /run #\d+/ })).toBeVisible()
  await web.getByRole('link', { name: 'Started just now →' }).click()
  await expect(page).toHaveURL(/\/runbooks\/runs\/\d+$/)
  await expect(page.getByText(/Started by schedule:Web highstate/)).toBeVisible()
  await expect(page.getByRole('list', { name: 'Steps' }).getByRole('listitem', { name: 'Sync modules: done' })).toBeVisible()

  // the editor asks for the runbook's values
  await page.goto('/schedules')
  await page.getByRole('listitem').filter({ hasText: 'Web highstate' }).getByRole('button', { name: 'Edit' }).click()
  await expect(page.getByRole('combobox', { name: 'Runbook', exact: true })).toHaveValue('2')
  await expect(page.getByRole('textbox', { name: 'Minions' })).toHaveValue('web-*')
  await page.getByRole('button', { name: 'Cancel' }).click()

  await page.goto('/runbooks')
  await page.getByRole('button', { name: 'Delete Sync and apply the highstate' }).click()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByText('The schedule "Web highstate" runs it')).toBeVisible()
})

test('a webhook starts a runbook with the values a call may set', async ({ page }) => {
  await openDemo(page, '/runbooks')
  await expect(page.getByRole('listitem', { name: 'Alertmanager: nginx down' })).toContainText('the call sets host')
  await page.getByRole('button', { name: 'New webhook' }).click()
  await page.getByLabel('Webhook name').fill('CI deploy')
  await page.getByLabel('Runbook it starts').selectOption({ label: 'Sync and apply the highstate' })
  // the runbook's default (web-*) unless the call says otherwise
  await page.getByLabel('The call may set Minions').check()
  await page.getByRole('button', { name: 'Create webhook' }).click()
  await expect(page.getByLabel('Webhook secret')).toHaveValue(/^whk_/)
  await page.getByRole('button', { name: 'Done' }).click()

  const hook = page.getByRole('listitem', { name: 'CI deploy' })
  await expect(hook).toContainText('/api/hooks/runbooks/')
  await hook.getByRole('button', { name: 'Test call…' }).click()
  await page.getByLabel('Request body').fill('{"target": "web-01", "ref": "main"}')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page).toHaveURL(/\/runbooks\/runs\/\d+$/)
  await expect(page.getByText(/Started by hook:CI deploy/)).toBeVisible()
  await expect(page.getByRole('list', { name: 'Steps' }).getByRole('listitem', { name: 'Sync modules: done' })).toBeVisible()
})

test('a compliance schedule fixes the drift it finds with a change', async ({ page }) => {
  await openDemo(page, '/schedules')
  const nightly = page.getByRole('listitem').filter({ hasText: 'Nightly compliance' })
  await expect(nightly.getByText('fixes drift, 50% at a time')).toBeVisible()
  await nightly.getByRole('link', { name: /fixing in #\d+/ }).click()
  await expect(page.getByText('Fix the drift that "Nightly compliance" found')).toBeVisible()
  await expect(page.getByText('schedule:Nightly compliance').first()).toBeVisible()

  await page.goto('/schedules')
  await page.getByRole('listitem').filter({ hasText: 'Nightly compliance' }).getByRole('button', { name: 'Edit' }).click()
  await expect(page.getByLabel('Fix the drift it finds')).toBeChecked()
  await expect(page.getByLabel('Batch size')).toHaveValue('50%')
  await page.getByLabel('Batch size').fill('lots')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText(/Batch size is a number of minions or a percentage/)).toBeVisible()
})

test('the fleet report puts the week on one page and prints it', async ({ page }) => {
  await openDemo(page, '/notifications')
  await page.getByRole('link', { name: 'Printable report' }).click()
  await expect(page.getByRole('heading', { name: 'Fleet report' })).toBeVisible()
  await expect(page.getByText('Failed jobs')).toBeVisible()
  await expect(page.getByText(/of the checked minions are in compliance/)).toBeVisible()
  await expect(page.getByRole('table').getByRole('row')).not.toHaveCount(1)
  // the printed page leaves out the menus
  await page.emulateMedia({ media: 'print' })
  await expect(page.getByRole('button', { name: 'Print or save as PDF' })).toBeHidden()
  await expect(page.getByText('Salt Shaker fleet report')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Overview' })).toBeHidden()
})

test('a notification channel can send email to a list of people', async ({ page }) => {
  await openDemo(page, '/notifications')
  await page.getByRole('button', { name: 'Add channel' }).click()
  await page.getByLabel('Name').fill('Management')
  await page.getByLabel('Format').selectOption('email')
  await page.getByLabel('Recipients').fill('cto@example.com, nope')
  await page.getByRole('button', { name: 'Add channel' }).last().click()
  await expect(page.getByText('"nope" is not an email address')).toBeVisible()
  await page.getByLabel('Recipients').fill('CTO@example.com, ops@example.com')
  await page.getByRole('button', { name: 'Add channel' }).last().click()
  const mgmt = page.getByRole('listitem').filter({ hasText: 'Management' })
  await expect(mgmt.getByText('Email', { exact: true })).toBeVisible()
  await expect(mgmt).toContainText('cto@example.com, ops@example.com')
})

test('the demo audits what is done in it, and what was denied', async ({ page }) => {
  await openDemo(page, `/run?${new URLSearchParams({ tgt: 'web-01', tgt_type: 'list', fun: 'cmd.run', args: "'hostname'" })}`)
  await page.getByRole('button', { name: 'Run on 1' }).click()
  await expect(page.getByText('1/1 returned')).toBeVisible()

  await page.getByRole('link', { name: 'Audit log' }).click()
  await expect(page.getByRole('button', { name: /demo ok cmd\.run → list:web-01/ })).toBeVisible()
  await page.getByLabel('Outcome').selectOption('denied')
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await expect(page.getByRole('button', { name: /vic denied cmd\.run → db-01/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /demo ok/ })).toHaveCount(0)

  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export CSV' }).click()
  const lines = (await readFile(await (await download).path(), 'utf8')).trim().split('\r\n')
  expect(lines[0]).toBe('id,at,username,role,client,function,target,target_type,arguments,jid,outcome,error,ip')
  expect(lines.slice(1).every((l) => l.includes(',denied,'))).toBe(true)
})

test('the demo has a team to manage and a System page', async ({ page }) => {
  await openDemo(page, '/users')
  await expect(page.getByText('Vic Viewer')).toBeVisible()
  await page.getByLabel('Role of vic').selectOption('operator')
  await expect(page.getByLabel('Role of vic')).toHaveValue('operator')
  // an operator can be limited to some minions
  await expect(page.getByRole('button', { name: 'Change what otto can run on' })).toContainText('web-*')
  await page.getByRole('button', { name: 'Change what vic can run on' }).click()
  await page.getByLabel('Target').fill('G@roles:db')
  await page.getByLabel('Match by').selectOption('compound')
  await page.getByRole('button', { name: 'Limit to this target' }).click()
  await expect(page.getByRole('button', { name: 'Change what vic can run on' })).toContainText('compound:G@roles:db')
  // and it's in the audit log
  await page.getByRole('link', { name: 'Audit log' }).click()
  await expect(page.getByRole('button', { name: /demo ok user\.set_role → vic/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /demo ok user\.set_scope → vic/ })).toBeVisible()

  await page.getByRole('link', { name: 'System' }).click()
  await expect(page.getByText('Connected').first()).toBeVisible()
  await expect(page.getByText('salt-master.lab.internal').first()).toBeVisible()
})

test('a command rolls out in batches from Run, and stops when a minion fails', async ({ page }) => {
  await openDemo(page, `/run?${new URLSearchParams({ tgt: 'web-*', fun: 'cmd.run', args: "'uptime'" })}`)
  await page.getByLabel('Roll out in batches').check()
  await page.getByLabel('Batch size').fill('1')
  await page.getByLabel('Why').fill('Check uptime one by one')
  await page.getByRole('button', { name: /^Start rollout on 2/ }).click()
  // it changes minions, so it's confirmed like any other run
  await page.getByRole('button', { name: 'Start rollout on 2', exact: true }).last().click()
  await expect(page).toHaveURL(/\/changes\/\d+$/)
  await expect(page.getByText('Check uptime one by one')).toBeVisible()
  await expect(page.getByText('done', { exact: true })).toBeVisible()
  await expect(page.getByText('2 ok')).toBeVisible()
  await expect(page.getByText('Batch 2')).toBeVisible()

  // nginx won't restart on web-02 in the demo: the rollout stops there
  await page.goto(`/run?${new URLSearchParams({ tgt: 'web-*', fun: 'service.restart', args: 'nginx' })}`)
  await page.getByLabel('Roll out in batches').check()
  await page.getByLabel('Batch size').fill('1')
  await page.getByLabel('Why').fill('Restart nginx')
  await page.getByRole('button', { name: /^Start rollout on 2/ }).click()
  await page.getByRole('button', { name: 'Start rollout on 2', exact: true }).last().click()
  await expect(page.getByText('stopped', { exact: true })).toBeVisible()
  await expect(page.getByText('1 minion failed (web-02); at most 0 allowed')).toBeVisible()
  await expect(page.getByText('1 ok · 1 failed')).toBeVisible()
})

test("an operator's change waits for an admin's approval", async ({ page }) => {
  await openDemo(page, '/changes')
  await expect(page.getByText('Waiting for approval (1)')).toBeVisible()
  await page.getByRole('link', { name: /#2 pkg\.install/ }).first().click()
  await expect(page.getByText('Nothing runs until it is approved.')).toBeVisible()
  await page.getByRole('button', { name: 'Approve' }).click()
  await expect(page.getByText('done', { exact: true })).toBeVisible()
  await expect(page.getByText('Approved')).toBeVisible()
  // and it's in the audit log
  await page.getByRole('link', { name: 'Audit log' }).click()
  await expect(page.getByRole('button', { name: /demo ok change\.approve → #2 pkg\.install/ })).toBeVisible()
})

test('a branch of the states can be previewed against base', async ({ page }) => {
  await openDemo(page, '/compliance')
  await page.getByRole('link', { name: 'Preview a branch' }).click()
  await expect(page.getByLabel('Branch')).toHaveValue('nginx-tls')
  await page.getByLabel('Target').fill('web-*')
  await page.getByRole('button', { name: 'Preview' }).click()
  await expect(page.getByText('2 of 2 minions would differ')).toBeVisible()
  const web01 = page.getByRole('listitem').filter({ has: page.getByRole('link', { name: 'web-01' }) })
  await expect(web01.getByText('/etc/nginx/conf.d/tls.conf', { exact: true })).toBeVisible()
  await expect(web01.getByText('new, would change')).toBeVisible()
  await expect(web01.getByText('not applied any more')).toBeVisible()
})

test('API tokens are shown once and can be revoked', async ({ page }) => {
  await openDemo(page, '/tokens')
  await expect(page.getByText('gitlab: deploy pipeline')).toBeVisible()
  await page.getByLabel('Token name').fill('nightly report')
  await page.getByRole('button', { name: 'Make a token' }).click()
  await expect(page.getByRole('heading', { name: 'Token for nightly report' })).toBeVisible()
  await expect(page.getByLabel('API token')).toHaveText(/^ss_[\w-]{43}$/)
  await page.getByRole('button', { name: 'Done' }).click()
  const row = page.getByRole('listitem').filter({ hasText: 'nightly report' })
  await expect(row).toContainText('never used')
  await row.getByRole('button', { name: 'Revoke' }).click()
  await page.getByRole('button', { name: 'Revoke', exact: true }).last().click()
  await expect(page.getByText('nightly report')).toHaveCount(0)
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

  // an upgrade that stops short of the fixed version doesn't count
  await expect(page.getByRole('cell', { name: 'kernel', exact: true })).toHaveCount(0)
  await page.getByText(/Fixes vulnerabilities/).click()
  await page.getByRole('button', { name: 'By minion' }).click()
  await page.getByRole('button', { name: /mon-01/ }).click()
  await expect(page.getByText('fix needs 5.14.0-503.15.1.el9_5')).toBeVisible()
  await page.getByRole('button', { name: 'By package' }).click()
  await page.getByText(/Fixes vulnerabilities/).click()

  // one click upgrades only those, only where they fix something
  await page.getByRole('button', { name: 'Upgrade security fixes' }).click()
  await expect(page.getByRole('heading', { name: 'Upgrade security fixes on 2 minions' })).toBeVisible()
  await expect(page.getByText('pkg.install pkgs=["libssl3t64","nginx","openssl"] only_upgrade=True')).toBeVisible()
  await expect(page.getByText('Afterwards, their package inventory is refreshed')).toBeVisible()
  await page.getByRole('button', { name: 'Upgrade 2 minions' }).click()
  await expect(page.getByText('2/2 returned')).toBeVisible()
  // then the package inventory is refreshed for the vulnerability report
  await expect(page.getByText('Package inventory refreshed on 2 minions')).toBeVisible()
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

test('an enrollment window accepts the new keys that match it', async ({ page }) => {
  await openDemo(page, '/keys')
  await page.getByLabel('Minion ids like').fill('*')
  await page.getByRole('button', { name: 'Open a window' }).click()
  await expect(page.getByText(/The pattern has to name the minions/)).toBeVisible()
  await page.getByLabel('Minion ids like').fill('edge-*')
  await page.getByRole('button', { name: 'Open a window' }).click()
  await expect(page.getByText('accepted 1 of 10: edge-lon-01')).toBeVisible()
  await expect(page.getByRole('heading', { name: /Accepted\s*7/ })).toBeVisible()
  // worker-02 doesn't match and still waits
  await expect(page.locator('li', { hasText: 'worker-02' }).getByRole('button', { name: 'Accept' })).toBeVisible()
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.getByText('closed', { exact: true })).toBeVisible()
})

test('keys of minions quiet for long can be deleted together', async ({ page }) => {
  await openDemo(page, '/keys')
  await expect(page.getByRole('heading', { name: 'Quiet for a while (1)' })).toBeVisible()
  await expect(page.getByText(/last answered/)).toBeVisible()
  // 180 days is longer than cache-01 has been quiet
  await page.getByLabel('Quiet for at least').selectOption('180')
  await expect(page.getByText('Every accepted minion answered within the last 180 days.')).toBeVisible()
  await page.getByLabel('Quiet for at least').selectOption('30')
  await page.getByRole('button', { name: 'Delete key', exact: true }).click()
  await page.getByRole('heading', { name: 'Delete 1 key?' }).waitFor()
  await page.getByRole('button', { name: 'Delete key', exact: true }).last().click()
  await expect(page.getByRole('heading', { name: /Accepted\s*5/ })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Quiet for a while (0)' })).toBeVisible()
})

test('the weekly report shows how the fleet did and can be sent now', async ({ page }) => {
  await openDemo(page, '/notifications')
  await expect(page.getByText(/^Weekly report: 6 minions, \d+ failed jobs?, \d+ critical vulnerabilit(y|ies)$/)).toBeVisible()
  await expect(page.getByText('Minions: 6 accepted, 1 not answering, 1 quiet for 30+ days')).toBeVisible()
  await page.getByRole('button', { name: 'Send now' }).click()
  await expect(page.getByRole('button', { name: 'Sent' })).toBeVisible()
})

test('hardening checks score the minions and say who fails what', async ({ page }) => {
  await openDemo(page, '/compliance')
  await page.getByRole('link', { name: 'Hardening checks' }).click()
  // Compliance has a target field too: wait until the page has changed
  await expect(page.getByRole('heading', { name: 'Hardening checks', level: 1 })).toBeVisible()
  await page.getByLabel('Match by').selectOption('list')
  await page.getByLabel('Target').fill('web-01,web-02,db-01')
  await expect(page.getByText('3 minions:')).toBeVisible()
  await page.getByRole('button', { name: 'Run the checks' }).click()
  // db-01 has a setuid shell in /tmp; web-02 takes SSH passwords
  await expect(page.locator('li', { hasText: 'No setuid programs in temporary directories' }).getByText('fails on 1')).toBeVisible()
  await expect(page.locator('li', { hasText: 'SSH takes keys, not passwords' }).locator('p.font-mono')).toHaveText('web-02')
  await expect(page.locator('li', { has: page.getByRole('link', { name: 'db-01' }) }).getByText('93%')).toBeVisible()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Evidence (CSV)' }).click()
  expect((await download).suggestedFilename()).toMatch(/^hardening-\d{4}-\d{2}-\d{2}\.csv$/)
})

test('the map groups minions and colours them by the chosen state', async ({ page }) => {
  await openDemo(page, '/map')
  const net = page.getByRole('region', { name: 'Network (/24): 10.0.2.0/24' })
  await expect(net.getByRole('link', { name: 'cache-01: not answering' })).toBeVisible()
  await page.getByLabel('Colour by').selectOption('vulns')
  await expect(page.getByRole('link', { name: /^db-01: \d+ critical$/ })).toBeVisible()
  await page.getByLabel('Group by').selectOption('os')
  await expect(page.getByRole('region', { name: /^Operating system: Rocky/ })).toBeVisible()
  await page.getByRole('link', { name: /^db-01:/ }).click()
  await expect(page).toHaveURL(/\/minions\/db-01$/)
})

test('the other masters show on the overview, and admins add them on System', async ({ page }) => {
  await openDemo(page, '/')
  const all = page.locator('table', { hasText: 'Awaiting approval' })
  await expect(all.getByRole('row', { name: /prod-us/ })).toContainText('48')
  await expect(all.getByRole('row', { name: /lab/ })).toContainText('No answer within 5 seconds')
  await page.getByText('demo', { exact: true }).first().click()
  await expect(page.getByRole('link', { name: 'prod-us' })).toBeVisible()

  await page.goto('/system')
  const addPeer = page.locator('form', { has: page.getByLabel('Instance name') }).getByRole('button', { name: 'Add', exact: true })
  await page.getByLabel('Instance name').fill('prod-ap')
  await page.getByLabel('Instance address').fill('https://salt-ap.example.com')
  await page.getByLabel('API token from there').fill('nope')
  await addPeer.click()
  await expect(page.getByText(/it starts with ss_/)).toBeVisible()
  await page.getByLabel('API token from there').fill('ss_demo')
  await addPeer.click()
  await expect(page.getByText('https://salt-ap.example.com')).toBeVisible()
  await page.getByRole('button', { name: 'Remove prod-ap' }).click()
  await expect(page.getByText('https://salt-ap.example.com')).toHaveCount(0)
})

test('schedules wait for a maintenance window, and Run says when the next one opens', async ({ page }) => {
  await openDemo(page, '/schedules')
  await expect(page.getByRole('listitem').filter({ hasText: 'Weekly patch scan' }).getByTitle('Waits for this maintenance window when it comes due outside it')).toContainText('Patch nights')

  await page.goto('/run')
  await expect(page.getByRole('status').filter({ hasText: 'maintenance window' })).toContainText(/Patch nights|Inside the maintenance window/)

  await page.goto('/system')
  await page.getByLabel('Window name').fill('Every day')
  for (const day of ['Mon', 'Wed', 'Fri', 'Sat', 'Sun']) await page.getByRole('button', { name: day, exact: true }).click()
  await page.getByLabel('Opens at').fill('00:00')
  await page.getByLabel('Window length').selectOption('1440')
  await page.locator('form', { has: page.getByLabel('Window name') }).getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.getByText('Every day 00:00 for 24 h')).toBeVisible()
  await expect(page.getByText(/^open until/)).toBeVisible()
  await page.getByRole('button', { name: 'Remove Every day' }).click()
  await expect(page.getByText('Every day 00:00 for 24 h')).toHaveCount(0)
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
