import { gzipSync } from 'node:zlib'
import { card, expect, exported, heading, id, json, sample, stat, tab, task, test, upload, worked, workedFixed } from './fixtures.ts'

test('landing page leads to the tool', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('banner').getByRole('link', { name: 'Open a trace' }).click()
  await expect(page.getByRole('heading', { name: 'Open a saved trace' })).toBeVisible()
})

const SAMPLES: [string, RegExp][] = [
  ['GPU actor starved by CPU preprocessing', /preprocess.*is starving.*EmbedModel/],
  ['Flaky reads retried by Ray', /thrown away on failed attempts that Ray retried/],
  ['Data skew with stragglers', /21 straggler tasks/],
  ['Too-small tasks', /score_row tasks are too small/],
]
for (const [name, diagnosis] of SAMPLES) {
  test(`sample: ${name}`, async ({ page }) => {
    await page.goto('/app')
    await page.locator('.sample', { hasText: name }).click()
    await expect(heading(page)).toHaveText(name)
    const c = card(page, diagnosis)
    await expect(c).toHaveClass(/active/)
    expect(await c.locator('.evidence li').count()).toBeGreaterThan(0)
    await expect(c.getByText('What to try')).toBeVisible()
    await expect(page.locator('.stage canvas').first()).toBeVisible()
    await expect(page.getByRole('img', { name: /^Busy workers over/ })).toBeVisible()
    await expect(page.getByRole('img', { name: /^Heatmap of/ })).toBeVisible()
    await tab(page, 'Flame summary')
    await expect(page.locator('.flame .fl').first()).toBeVisible()
    await tab(page, 'Distributions')
    await expect(page.getByRole('img', { name: /duration distribution/ }).first()).toBeVisible()
    await tab(page, 'Trace report')
    await expect(page.locator('.kv')).toContainText('task spans')
  })
}

test('stress test: 300,000 tasks are parsed and labelled synthetic', async ({ page }) => {
  test.setTimeout(180_000)
  await page.goto('/app')
  await page.locator('.sample', { hasText: 'Stress test' }).click()
  await expect(stat(page, /Tasks on/)).toHaveText('300,000', { timeout: 120_000 })
  await expect(page.locator('.statbar')).toContainText('Not a real trace')
})

for (const gz of [false, true]) {
  test(`hand-worked trace, ${gz ? '.json.gz' : '.json'}`, async ({ page }) => {
    await page.goto('/app')
    await upload(page, gz ? 'worked.json.gz' : 'worked.json', gz ? gzipSync(json(worked)) : json(worked))
    await expect(stat(page, 'Job time')).toHaveText('10.0 s')
    await expect(stat(page, 'of 2 slots (inferred) busy')).toHaveText('75%')
    await expect(stat(page, 'Tasks on 2 workers, 1 node')).toHaveText('5')
    await expect(stat(page, 'GPU workers')).toHaveText('0')
    const c = card(page, '2.00 s thrown away on failed attempts that Ray retried')
    await expect(c).toContainText('1.00 s to 2.00 s est. saved (20% at most)')
    await expect(c).toContainText('1 failed attempt across 1 task: 2.00 s, 13% of all task time.')
    await tab(page, 'Task types')
    const row = page.locator('.tbl tbody tr', { hasText: 'load' }).locator('td')
    await expect(row).toHaveText(['load', '4', '13.0 s', '1.00 s', '1.20 s', '2.50 s', '5.55 s', '6.00 s', '2'])
    const rep = JSON.parse((await exported(page, 'JSON')).text)
    expect(rep.summary.busySeconds).toBeCloseTo(15, 6)
    expect(rep.summary.parallelism).toBeCloseTo(1.5, 6)
    expect(rep.summary.criticalSeconds).toBeCloseTo(8, 6)
  })
}

test('bare array, {"traceEvents": ...}, BOM and CRLF forms read the same', async ({ page }) => {
  await page.goto('/app')
  const forms = {
    'wrapped.json': JSON.stringify({ displayTimeUnit: 'ms', traceEvents: worked }),
    'bom-crlf.json': '\ufeff' + JSON.stringify(worked, null, 2).replace(/\n/g, '\r\n'),
  }
  for (const [name, text] of Object.entries(forms)) {
    await upload(page, name, Buffer.from(text))
    await expect(heading(page)).toHaveText(name)
    await expect(stat(page, 'Job time')).toHaveText('10.0 s')
    await expect(stat(page, 'slots')).toHaveText('75%')
  }
})

test('mapping GPU workers by hand changes the attribution', async ({ page }) => {
  await page.goto('/app')
  await upload(page, 'worked.json', json(worked))
  await expect(card(page, 'GPU workers idle')).toHaveCount(0)
  await tab(page, 'Settings')
  // save ran on w1 only, which was idle 6-8 s: 2 of 10 s.
  await page.getByLabel('GPU task types').fill('save')
  await expect(stat(page, 'GPU workers')).toHaveText('1')
  const c = card(page, 'GPU workers idle 20% of the time they were held')
  await expect(c).toContainText('2.00 s lost worker time')
  await page.getByLabel('GPUs per worker').fill('2')
  await expect(c).toContainText('4.00 s lost worker time')
  await page.getByLabel('GPU task types').fill('nothing-matches')
  await expect(stat(page, 'GPU workers')).toHaveText('0')
  await expect(card(page, 'GPU workers idle')).toHaveCount(0)
})

test('a real slot count replaces the inferred one', async ({ page }) => {
  await page.goto('/app')
  await upload(page, 'worked.json', json(worked))
  await tab(page, 'Settings')
  await page.getByLabel('Worker slots').fill('5')
  await expect(stat(page, /of 5 slots busy/)).toHaveText('30%') // 15 of 50
})

test('compare two runs: hand-worked pair', async ({ page }) => {
  await page.goto('/app')
  await upload(page, 'before.json', json(worked))
  await tab(page, 'Compare')
  await page.locator('.cmp-empty input[type=file]').setInputFiles({ name: 'after.json', mimeType: 'application/json', buffer: json(workedFixed) })
  const cmp = page.locator('.compare')
  await expect(cmp.locator('.stat-grid')).toContainText('−2.00 s20% faster (measured)')
  await expect(cmp.locator('.predicted')).toContainText('estimated 1.00 s to 2.00 s saved. This run measured 2.00 s')
  await expect(cmp.locator('tbody tr', { hasText: 'load' }).locator('td').nth(1)).toHaveText('4 → 3')
  await expect(cmp.locator('.cmp-lists > div').first()).toContainText('2.00 s thrown away')
  await page.getByRole('button', { name: 'Clear comparison' }).click()
  await expect(cmp).toHaveCount(0)
})

test('compare a sample with its fixed pair', async ({ page }) => {
  await page.goto('/app?sample=small')
  await tab(page, 'Compare')
  await page.getByRole('button', { name: 'After: 100 rows per task' }).click()
  await expect(page.locator('.compare .stat-grid')).toContainText('faster (measured)')
  await expect(page.locator('.cmp-lists > div').first()).toContainText('score_row tasks are too small')
})

test('exports hold aggregates only and escape hostile task names', async ({ page }) => {
  const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>"\'&'
  const events = Array.from({ length: 12 }, (_, i) => task(evil, `w${i % 2}`, i * 0.3, 0.28, id(i + 1), 0.12, 0.09)).flat()
  await page.goto('/app')
  await upload(page, 'evil<b>.json', json(events))
  await expect(stat(page, 'Tasks on')).toHaveText('12')
  expect(await page.locator('.tool img[src=x]').count()).toBe(0)
  const html = await exported(page, 'HTML')
  expect(html.text).not.toMatch(/<script|<img|<b>\.json/i)
  expect(html.text).toContain('&lt;img src=x onerror=alert(1)&gt;')
  expect(html.text).not.toMatch(/[0-9a-f]{48}/)
  const rep = await exported(page, 'JSON')
  expect(rep.name).toMatch(/-report\.json$/)
  const data = JSON.parse(rep.text)
  expect(data.taskTypes[0]).toMatchObject({ name: evil, n: 12 })
  expect(data).not.toHaveProperty('spans')
  expect(rep.text).not.toMatch(/[0-9a-f]{48}/)
  // The saved report is static: opening it runs nothing.
  await page.setContent(html.text)
  expect(await page.locator('script, img').count()).toBe(0)
  await expect(page.locator('h1')).toHaveText('evil<b>.json')
})

const BAD: [string, string | Buffer, RegExp][] = [
  ['empty.json', '', /file is empty/],
  ['text.json', 'hello', /does not start with a JSON array or object/],
  ['page.html.json', '<!doctype html><p>Sign in', /does not start with a JSON array or object/],
  ['object.json', '{"foo":1}', /no .?traceEvents.? array/],
  ['no-events.json', '[]', /No Ray spans found/],
  ['not-ray.json', '[{"ph":"X","cat":"mine","name":"x","pid":1,"tid":1,"ts":1,"dur":2}]', /No Ray spans found/],
  ['cut-first-event.json', '[{"ph":"X","cat":"task::a","pid":1,"ti', /ends before the trace closes|No Ray spans/],
  ['cut.json.gz', sample('small').subarray(0, 12), /corrupt or truncated|file is empty/],
  ['bad-times.json', '[{"ph":"X","cat":"task::a","pid":1,"tid":1,"ts":"soon","dur":2}]', /No Ray spans found/],
]
for (const [name, content, message] of BAD) {
  test(`wrong file: ${name}`, async ({ page }) => {
    await page.goto('/app')
    await upload(page, name, Buffer.from(content as string))
    await expect(page.getByRole('alert')).toContainText(`No Ray tasks to analyze in ${name}`)
    await expect(page.getByRole('alert')).toContainText(message)
    await expect(page.locator('.statbar, .diag, .exports')).toHaveCount(0)
  })
}

test('a bad comparison file is named and compares nothing', async ({ page }) => {
  await page.goto('/app')
  await upload(page, 'worked.json', json(worked))
  await tab(page, 'Compare')
  await page.locator('.cmp-empty input[type=file]').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('nope') })
  await expect(page.getByRole('alert')).toContainText('bad.json has no Ray tasks to compare')
  await expect(page.locator('.compare')).toHaveCount(0)
})

test('settings, theme and the chosen sample survive a reload', async ({ page }) => {
  await page.goto('/app?sample=skew')
  await tab(page, 'Settings')
  await page.getByLabel('Worker slots').fill('16')
  await expect(stat(page, 'of 16 slots busy')).toBeVisible()
  await page.getByRole('button', { name: 'Switch to dark mode' }).click()
  await page.reload()
  await expect(heading(page)).toHaveText('Data skew with stragglers')
  await expect(stat(page, 'of 16 slots busy')).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'dark')
})

test('a settings link carries settings only; a malformed one is ignored', async ({ page, context, baseURL }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL })
  await page.goto('/app')
  await upload(page, 'worked.json', json(worked))
  await tab(page, 'Settings')
  await page.getByLabel('GPU task types').fill('save')
  await page.getByRole('button', { name: 'Copy settings link' }).click()
  const url = await page.evaluate(() => navigator.clipboard.readText())
  expect(JSON.parse(Buffer.from(url.split('#s=')[1], 'base64url').toString())).toEqual({ gpuPatterns: 'save' })
  await page.evaluate(() => localStorage.clear())
  await page.goto('/')
  await page.goto(url)
  await upload(page, 'worked.json', json(worked))
  await expect(stat(page, 'GPU workers')).toHaveText('1')
  await page.evaluate(() => localStorage.clear())
  await page.goto('/')
  await page.goto('/app#s=%%%not-base64')
  await upload(page, 'worked.json', json(worked))
  await expect(stat(page, 'GPU workers')).toHaveText('0')
})

test('a multi-job dump warns, and a job filter restricts the numbers', async ({ page }) => {
  await page.goto('/app')
  await upload(page, 'two-jobs.json', json([...worked, ...task('other', 'w3', 40, 5, id(9, '02000000'))]))
  await expect(stat(page, 'Job time')).toHaveText('45.0 s')
  await tab(page, 'Trace report')
  await expect(page.locator('.issues')).toContainText('This trace holds 2 jobs')
  await tab(page, 'Settings')
  await page.getByRole('combobox', { name: 'Job' }).selectOption('01000000')
  await expect(stat(page, 'Job time')).toHaveText('10.0 s')
  await page.getByRole('combobox', { name: 'Job' }).selectOption('02000000')
  await expect(stat(page, 'Job time')).toHaveText('5.00 s')
})

test('a trace never leaves the page', async ({ page, outside }) => {
  const posts: string[] = []
  page.on('request', (r) => { if (r.method() !== 'GET') posts.push(r.url()) })
  await page.goto('/app')
  await upload(page, 'worked.json', json(worked))
  await expect(stat(page, 'Job time')).toHaveText('10.0 s')
  await tab(page, 'Settings')
  await page.getByLabel('GPU task types').fill('save')
  await expect(stat(page, 'GPU workers')).toHaveText('1')
  expect(posts).toEqual([])
  expect(outside).toEqual([])
})
