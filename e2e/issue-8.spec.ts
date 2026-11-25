import { card, expect, id, json, span, stat, tab, test, upload } from './fixtures.ts'

test.fail('#8 another job\'s submissions are not this job\'s queue', async ({ page }) => {
  const ev = []
  for (let i = 0; i < 40; i++) ev.push(span('submit_task', 'd1', i * 0.01, 0.001), span('task::a', `w${i % 4}`, 1 + Math.floor(i / 4), 0.9, id(i + 1)))
  for (let i = 0; i < 40; i++) ev.push(span('submit_task', 'd2', 20 + i * 0.5 - 0.01, 0.001), span('task::b', `w${i % 2}`, 20 + i * 0.5, 0.5, id(i + 100, '02000000')))
  await page.goto('/app')
  await upload(page, 'two-jobs.json', json(ev))
  await tab(page, 'Settings')
  await page.getByLabel('Worker slots').fill('4')
  await page.getByRole('combobox', { name: 'Job' }).selectOption('02000000')
  await expect(stat(page, 'Job time')).toHaveText('20.0 s')
  await expect(card(page, 'b never ran in parallel')).toBeVisible()
  await expect(card(page, 'Idle slots while work was waiting')).toHaveCount(0)
})
