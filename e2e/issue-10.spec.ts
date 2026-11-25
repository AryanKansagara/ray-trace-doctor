import { expect, test } from './fixtures.ts'

test.fail('#10 no page requests another origin', async ({ page, outside }) => {
  for (const path of ['/', '/app?sample=skew']) {
    await page.goto(path)
    await expect(page.getByRole('contentinfo')).toBeVisible()
    await page.waitForLoadState('networkidle')
  }
  expect(outside).toEqual([])
})
