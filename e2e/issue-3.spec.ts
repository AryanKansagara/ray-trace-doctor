import { expect, exported, heading, id, json, sample, stat, task, test, upload, worked } from './fixtures.ts'

const cut = json(worked).subarray(0, -1)
const CASES: [string, Buffer, RegExp][] = [
  ['cut.json', cut, /file ends before the trace closes/],
  ['cut.json.gz', sample('skew').subarray(0, 60_000), /gzip stream is corrupt or truncated/],
  ['mostly-bad.json', json([...worked, ...Array.from({ length: 50 }, () => ({ ...worked[0], ts: 'soon' }))]), /missing, non-numeric or negative ts\/dur/],
]
for (const [name, bytes, why] of CASES) {
  test.fail(`#3 ${name} is shown and exported as incomplete`, async ({ page }) => {
    await page.goto('/app')
    await upload(page, name, bytes)
    await expect(heading(page)).toHaveText(name)
    await expect(page.getByRole('alert')).toContainText('This trace is incomplete')
    await expect(page.getByRole('alert')).toContainText(why)
    const html = (await exported(page, 'HTML')).text
    expect(html.indexOf('This trace is incomplete')).toBeGreaterThan(0)
    expect(html.indexOf('This trace is incomplete')).toBeLessThan(html.indexOf('Job time'))
    expect(JSON.parse((await exported(page, 'JSON')).text).complete).toBe(false)
  })
}

test.fail('#3 a truncated trace with no diagnoses does not get a clean bill of health', async ({ page }) => {
  await page.goto('/app')
  await upload(page, 'cut-one.json', json(task('a', 'w1', 0, 1, id(1))).subarray(0, -1))
  await expect(stat(page, 'Job time')).toHaveText('1.00 s')
  await expect(page.getByText('kept its workers busy')).toHaveCount(0)
})

test('#3 a complete trace carries no incomplete notice', async ({ page }) => {
  await page.goto('/app')
  await upload(page, 'worked.json', json(worked))
  await expect(stat(page, 'Job time')).toHaveText('10.0 s')
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect((await exported(page, 'HTML')).text).not.toContain('incomplete')
})
