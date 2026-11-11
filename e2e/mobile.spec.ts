import { expect, test } from '@playwright/test'

test('mobile menu closes after picking a page', async ({ page }) => {
  await page.goto('/?demo')
  await page.getByRole('button', { name: 'Open menu' }).click()
  await page.getByRole('link', { name: 'Jobs', exact: true }).click()
  await expect(page).toHaveURL(/\/jobs$/)
  await expect(page.getByRole('button', { name: 'Close menu' })).toBeHidden()
  await expect(page.getByRole('heading', { name: 'Jobs' })).toBeVisible()
})

// pages that grew wide tables or long rows: nothing may push the page sideways on a phone
for (const path of ['/', '/minions', '/vulnerabilities', '/vulnerabilities?view=packages&q=ssl', '/query', '/schedules', '/notifications', '/audit', '/users', '/system', '/patches']) {
  test(`${path} fits a phone`, async ({ page }) => {
    await page.goto(`${path}${path.includes('?') ? '&' : '?'}demo`)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await page.waitForLoadState('networkidle')
    // a string: the e2e tests are compiled without the DOM types
    const { scroll, width } = await page.evaluate<{ scroll: number; width: number }>('({ scroll: document.documentElement.scrollWidth, width: window.innerWidth })')
    expect(scroll).toBeLessThanOrEqual(width)
  })
}

test('audit entries show the call on a phone', async ({ page }) => {
  await page.goto('/audit?demo')
  const row = page.getByRole('button', { name: /vic denied/ })
  // the function and its target on their own line, not cut to a few letters
  const call = row.getByText('cmd.run', { exact: false })
  const box = await call.boundingBox()
  expect(box!.width).toBeGreaterThan(100)
})

