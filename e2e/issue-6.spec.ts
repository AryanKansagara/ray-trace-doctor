import { card, expect, id, json, span, test, upload } from './fixtures.ts'

// prep 0-100 s; the actor's only span is 50-60 s. Held 50-100 = 50 s, busy 10 = 20%, idle 40 = 80%.
test('#6 a GPU actor that starts late is held from its first span', async ({ page }) => {
  await page.goto('/app')
  await upload(page, 'late.json', json([span('task::prep', 'c', 0, 100, id(1)), span('task::Model.infer', 'g', 50, 10, id(2, '01000000', 'a'.repeat(24)))]))
  const c = card(page, 'GPU workers idle')
  await expect(c.locator('h3')).toHaveText('GPU workers idle 80% of the time they were held')
  await expect(c).toContainText('1 GPU worker held for 50.0 s, busy 20% of that time.')
})
