import { card, expect, stat, tab, test } from './fixtures.ts'

const link = (s: object) => `#s=${Buffer.from(JSON.stringify(s)).toString('base64url')}`

test('#9 a link cannot set GPUs per worker to 0 and hide the GPU card', async ({ page }) => {
  await page.goto(`/app?sample=gpu_starved${link({ gpusPerWorker: 0 })}`)
  await expect(stat(page, 'GPU workers')).toHaveText('4')
  await expect(card(page, 'GPU workers idle')).toBeVisible()
})

test('#9 a link cannot set the target task size to 0 and hide the too-small card', async ({ page }) => {
  await page.goto(`/app?sample=small${link({ targetTaskMs: 0 })}`)
  await expect(stat(page, 'Tasks on')).toBeVisible()
  await expect(card(page, 'score_row tasks are too small')).toBeVisible()
})

test('#9 a link cannot set a billionth of a slot', async ({ page }) => {
  await page.goto(`/app?sample=small${link({ slots: 1e-9 })}`)
  await tab(page, 'Settings')
  await expect(page.getByLabel('Worker slots')).toHaveValue('0')
  await expect(page.locator('.statbar')).not.toContainText(/\d{4,}%/)
})

test('#9 what the panel stores survives a reload', async ({ page }) => {
  await page.goto('/app?sample=small')
  await tab(page, 'Settings')
  await page.getByLabel('Target task size').fill('-5')
  await expect(page.getByLabel('Target task size')).toHaveValue('100')
  await page.getByLabel('Target task size').fill('250')
  await page.getByLabel('GPU task types').fill('x'.repeat(600))
  await expect(page.getByLabel('GPU task types')).toHaveValue('x'.repeat(500))
  await page.reload()
  await tab(page, 'Settings')
  await expect(page.getByLabel('Target task size')).toHaveValue('250')
  await expect(page.getByLabel('GPU task types')).toHaveValue('x'.repeat(500))
})
