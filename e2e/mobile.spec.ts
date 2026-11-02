import { expect, test } from '@playwright/test'

test('mobile menu closes after picking a page', async ({ page }) => {
  await page.goto('/?demo')
  await page.getByRole('button', { name: 'Open menu' }).click()
  await page.getByRole('link', { name: 'Jobs' }).click()
  await expect(page).toHaveURL(/\/jobs$/)
  await expect(page.getByRole('button', { name: 'Close menu' })).toBeHidden()
  await expect(page.getByRole('heading', { name: 'Jobs' })).toBeVisible()
})
