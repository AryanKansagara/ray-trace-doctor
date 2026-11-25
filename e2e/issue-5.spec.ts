import { expect, exported, id, json, span, stat, test, upload } from './fixtures.ts'

const actor = (n: number) => id(n, '01000000', 'a'.repeat(24))

test.fail('#5 eight concurrent calls on one actor are one busy slot', async ({ page }) => {
  await page.goto('/app')
  await upload(page, 'async.json', json(Array.from({ length: 8 }, (_, i) => span('task::Api.call', 'a1', 0, 10, actor(i + 1)))))
  await expect(stat(page, 'of 1 slots (inferred) busy')).toHaveText('100%')
  const s = JSON.parse((await exported(page, 'JSON')).text).summary
  expect(s).toMatchObject({ slots: 1, utilization: 1, busySeconds: 10 })
})
