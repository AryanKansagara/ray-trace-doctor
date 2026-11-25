import { expect, id, json, span, tab, test, upload } from './fixtures.ts'
import type { Page } from '@playwright/test'

// 400 tasks of 4 ms each per name, 1 ms of it execute: "too small" for every name listed.
const small = (names: string[]) => {
  let t = 0
  let k = 0
  return names.flatMap((n) => Array.from({ length: 400 }, () => {
    const at = t
    t += 0.005
    return [span(`task::${n}`, 'w1', at, 0.004, id(++k)), span('task:deserialize_arguments', 'w1', at, 0.002), span('task:execute', 'w1', at + 0.002, 0.001)]
  }).flat())
}
const stragglers = (k: number) => Array.from({ length: 20 }, (_, i) => span('task::s', `w${i}`, 0, i < k ? 10 : 1, id(i + 1)))

async function compare(page: Page, before: unknown, after: unknown) {
  await page.goto('/app')
  await upload(page, 'before.json', json(before))
  await tab(page, 'Compare')
  await page.locator('.cmp-empty input[type=file]').setInputFiles({ name: 'after.json', mimeType: 'application/json', buffer: json(after) })
  return page.locator('.cmp-lists > div') // resolved, still there, new
}

test('#7 task names that differ only in digits are different findings', async ({ page }) => {
  const lists = await compare(page, small(['score_v1', 'score_v2']), small(['score_v2']))
  await expect(lists.nth(0)).toContainText('score_v1 tasks are too small')
  await expect(lists.nth(1)).toContainText('score_v2 tasks are too small')
})

test('#7 a singular count is still the same finding', async ({ page }) => {
  const lists = await compare(page, stragglers(2), stragglers(1))
  await expect(lists.nth(1)).toContainText('1 straggler task')
  await expect(lists.nth(0)).not.toContainText('straggler')
  await expect(lists.nth(2)).not.toContainText('straggler')
})
