import { expect, test } from '@playwright/test'

// ?demo=large: 606 generated minions, some down, some on an older Salt
test('a large fleet renders in pages and filters reset paging', async ({ page }) => {
  await page.goto('/?demo=large')
  await expect(page.getByText('Showing 100 of 606')).toBeVisible()
  await expect(page.getByRole('row')).toHaveCount(101) // header + one page

  await page.getByRole('button', { name: 'Show 100 more' }).click()
  await expect(page.getByText('Showing 200 of 606')).toBeVisible()

  // a fleet filter narrows the list and starts from the first page again
  await page.getByRole('button', { name: /3006\.9/ }).click()
  await expect(page.getByText(/Showing 200 of/)).toBeHidden()
  const behind = page.getByRole('row').filter({ hasText: '3006.9' })
  await expect(behind.first()).toBeVisible()
})

test('minions appear before the slow responding check finishes', async ({ page }) => {
  await page.goto('/?demo=large')
  // grains come from the cache right away; manage.status takes longer
  await expect(page.getByText('Pinging minions…')).toBeVisible()
  await expect(page.getByRole('cell', { name: 'api-ams-001' })).toBeVisible()
  await expect(page.getByText('Pinging minions…')).toBeHidden()
  const notResponding = page.locator('div', { has: page.getByText('Not responding', { exact: true }) }).last()
  await expect(notResponding).not.toContainText('—')
})

test('enrollment pages and filters accepted keys', async ({ page }) => {
  await page.goto('/keys?demo=large')
  await expect(page.getByRole('heading', { name: /Accepted\s*606/ })).toBeVisible()
  await expect(page.getByText('Showing 100 of 606')).toBeVisible()
  await page.getByLabel('Filter accepted keys').fill('worker-fra')
  await expect(page.getByText(/Showing 100 of/)).toBeHidden()
  await expect(page.locator('li', { hasText: 'worker-fra-' }).first()).toBeVisible()
  await expect(page.locator('li', { hasText: 'web-ams-' })).toHaveCount(0)
})

test('a run on many minions summarizes and pages its results', async ({ page }) => {
  await page.goto('/run?demo=large&tgt=*&fun=test.ping')
  await page.getByRole('button', { name: 'Run on 606' }).click()
  await expect(page.getByRole('button', { name: 'All 606' })).toBeVisible()
  await expect(page.getByText('Showing 50 of 606')).toBeVisible()
  // offline minions end up under Waiting until they are given up on
  await expect(page.getByText(/\d+ ok · 0 failed · \d+ waiting/)).toBeVisible()
})

test('a compliance check on many minions pages the list', async ({ page }) => {
  await page.goto('/compliance?demo=large')
  await page.getByRole('button', { name: 'Check now' }).click()
  await expect(page.getByRole('button', { name: /Remediate \d+ drifted/ })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText(/Showing 100 of \d+/)).toBeVisible()
})
