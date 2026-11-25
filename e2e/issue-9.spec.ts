import { card, expect, stat, test } from './fixtures.ts'

const link = (s: object) => `#s=${Buffer.from(JSON.stringify(s)).toString('base64url')}`

test.fail('#9 a link cannot set GPUs per worker to 0 and hide the GPU card', async ({ page }) => {
  await page.goto(`/app?sample=gpu_starved${link({ gpusPerWorker: 0 })}`)
  await expect(stat(page, 'GPU workers')).toHaveText('4')
  await expect(card(page, 'GPU workers idle')).toBeVisible()
})

test.fail('#9 a link cannot set the target task size to 0 and hide the too-small card', async ({ page }) => {
  await page.goto(`/app?sample=small${link({ targetTaskMs: 0 })}`)
  await expect(stat(page, 'Tasks on')).toBeVisible()
  await expect(card(page, 'score_row tasks are too small')).toBeVisible()
})
