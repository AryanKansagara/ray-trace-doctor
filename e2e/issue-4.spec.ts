import { expect, heading, id, json, stat, tab, task, test, upload, worked } from './fixtures.ts'

const two = json([...worked, ...task('other', 'w3', 40, 5, id(9, '02000000'))])

test('#4 a job filter from one dump does not blank a trace without that job', async ({ page }) => {
  await page.goto('/app')
  await upload(page, 'two-jobs.json', two)
  await tab(page, 'Settings')
  await page.getByRole('combobox', { name: 'Job' }).selectOption('02000000')
  await expect(stat(page, 'Job time')).toHaveText('5.00 s')
  await upload(page, 'one-job.json', json(worked))
  await expect(heading(page)).toHaveText('one-job.json')
  await expect(stat(page, 'Job time')).toHaveText('10.0 s')
  await tab(page, 'Trace report')
  await expect(page.locator('.issues')).toContainText('job 02000000')
  // The filter still applies to a dump that has the job.
  await upload(page, 'two-jobs.json', two)
  await expect(stat(page, 'Job time')).toHaveText('5.00 s')
  await page.goto('/app?sample=skew')
  await expect(heading(page)).toHaveText('Data skew with stragglers')
})
