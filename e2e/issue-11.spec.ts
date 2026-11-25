import { expect, exported, id, json, span, stat, test, upload } from './fixtures.ts'

test('#11 the chain passes a zero-duration task', async ({ page }) => {
  await page.goto('/app')
  await upload(page, 'zero.json', json([span('task::a', 'w1', 0, 5, id(1)), span('task::z', 'w1', 5, 0, id(2)), span('task::b', 'w1', 5, 5, id(3))]))
  await expect(stat(page, 'Job time')).toHaveText('10.0 s')
  expect(JSON.parse((await exported(page, 'JSON')).text).summary.criticalSeconds).toBeCloseTo(10, 6)
})

test('#11 the chain reaches back from a zero-duration last task', async ({ page }) => {
  await page.goto('/app')
  await upload(page, 'zero-last.json', json([span('task::a', 'w1', 0, 5, id(1)), span('task::b', 'w1', 5, 5, id(3)), span('task::z', 'w1', 10, 0, id(2))]))
  await expect(stat(page, 'Job time')).toHaveText('10.0 s')
  expect(JSON.parse((await exported(page, 'JSON')).text).summary.criticalSeconds).toBeCloseTo(10, 6)
})
