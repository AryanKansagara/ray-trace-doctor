import type { Page } from '@playwright/test'
import { expect, heading, json, stat, tab, test, upload, worked } from './fixtures.ts'

const loadByUrl = (page: Page) =>
  page.addInitScript(() => {
    const post = Worker.prototype.postMessage
    Worker.prototype.postMessage = function (this: Worker, m: any) {
      if (m.source?.file) m = { ...m, source: { url: `/held-${m.source.file.name}`, name: m.source.file.name } }
      return post.call(this, m)
    } as typeof post
  })

test('#2 a settings change during a load keeps the load, and the heading names the numbers shown', async ({ page, context }) => {
  // Hold the second file in the worker: the app's own URL loading path, gated by the test.
  let release = () => {}
  const gate = new Promise<void>((r) => (release = r))
  await context.route('**/held-*', async (route) => {
    await gate
    await route.fulfill({ body: json(worked), contentType: 'application/json' })
  })
  await loadByUrl(page)
  await page.goto('/app?sample=gpu_starved')
  await expect(heading(page)).toHaveText('GPU actor starved by CPU preprocessing')
  await tab(page, 'Settings')
  await upload(page, 'second.json', json(worked))
  await expect(page.getByRole('status')).toContainText('second.json')
  await expect(heading(page)).toHaveText('GPU actor starved by CPU preprocessing')
  await page.getByLabel('Worker slots').fill('5')
  await page.waitForTimeout(700) // past the settings debounce
  release()
  await expect(heading(page)).toHaveText('second.json')
  await expect(stat(page, 'Job time')).toHaveText('10.0 s')
  await expect(stat(page, 'of 5 slots busy')).toHaveText('30%')
  await page.getByLabel('GPU task types').fill('save')
  await expect(stat(page, 'GPU workers')).toHaveText('1')
  await expect(stat(page, 'Job time')).toHaveText('10.0 s')
})

test('#2 a failed load leaves the previous trace under its own name', async ({ page, context }) => {
  await context.route('**/held-*', (route) => route.fulfill({ status: 500 }))
  await loadByUrl(page)
  await page.goto('/app?sample=skew')
  await expect(heading(page)).toHaveText('Data skew with stragglers')
  await upload(page, 'broken.json', json(worked))
  await expect(page.getByRole('alert')).toContainText('broken.json could not be read.')
  await expect(heading(page)).toHaveText('Data skew with stragglers')
  await tab(page, 'Settings')
  await page.getByLabel('Worker slots').fill('16')
  await expect(stat(page, 'of 16 slots busy')).toBeVisible()
  await expect(heading(page)).toHaveText('Data skew with stragglers')
})

test('#2 a settings change while a comparison loads reaches the comparison', async ({ page, context }) => {
  let release = () => {}
  const gate = new Promise<void>((r) => (release = r))
  await context.route('**/samples/small_fixed*', async (route) => {
    await gate
    await route.continue()
  })
  await page.goto('/app?sample=small')
  await tab(page, 'Compare')
  await page.getByRole('button', { name: 'After: 100 rows per task' }).click()
  await tab(page, 'Settings')
  await page.getByLabel('Worker slots').fill('1000') // both runs far below 10% of 1,000 slots
  await page.waitForTimeout(700)
  release()
  await tab(page, 'Compare')
  await expect(page.locator('.compare .stat-grid')).toContainText(/\d% → 1%Slots busy/)
})
