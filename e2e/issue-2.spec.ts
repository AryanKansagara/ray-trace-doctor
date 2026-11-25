import { expect, heading, json, stat, tab, test, upload, worked } from './fixtures.ts'

test.fail('#2 a settings change during a load keeps the load, and the heading names the numbers shown', async ({ page, context }) => {
  // Hold the second file in the worker: the app's own URL loading path, gated by the test.
  let release = () => {}
  const gate = new Promise<void>((r) => (release = r))
  await context.route('**/held-*', async (route) => {
    await gate
    await route.fulfill({ body: json(worked), contentType: 'application/json' })
  })
  await page.addInitScript(() => {
    const post = Worker.prototype.postMessage
    Worker.prototype.postMessage = function (this: Worker, m: any) {
      if (m.source?.file) m = { ...m, source: { url: `/held-${m.source.file.name}`, name: m.source.file.name } }
      return post.call(this, m)
    } as typeof post
  })
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
