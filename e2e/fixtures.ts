import { test as base, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'

export { expect }

// Blocks every request to another origin and fails on any uncaught page error.
export const test = base.extend<{ outside: string[] }>({
  outside: [async ({ context, page, baseURL }, use) => {
    const outside: string[] = []
    const errors: string[] = []
    const origin = new URL(baseURL!).origin
    page.on('pageerror', (e) => errors.push(String(e)))
    await context.route((url) => url.protocol.startsWith('http') && url.origin !== origin, (route) => {
      outside.push(route.request().url())
      return route.abort()
    })
    await use(outside)
    expect(errors, 'uncaught page errors').toEqual([])
  }, { auto: true }],
})

// ---------- Traces built by hand. Times in seconds. ----------

export const id = (n: number, job = '01000000', actor = 'f'.repeat(24)) => n.toString(16).padStart(16, '0') + actor + job
export const span = (cat: string, worker: string, start: number, dur: number, taskId?: string) =>
  ({ cat, name: cat, pid: '10.0.0.1', tid: `worker:${worker}`, ph: 'X', ts: start * 1e6, dur: dur * 1e6, args: taskId ? { task_id: taskId } : {} })
export const task = (name: string, worker: string, start: number, dur: number, taskId: string, deser = 0, store = 0.1) => [
  span(`task::${name}`, worker, start, dur, taskId),
  span('task:deserialize_arguments', worker, start, deser),
  span('task:execute', worker, start + deser, dur - deser - store),
  ...(store ? [span('task:store_outputs', worker, start + dur - store, store)] : []),
]

/* Worked on paper.

   w1  load#1 0-6 (deser 1, store 1) ............ save#4 8-10      busy 6 + 2     =  8 s
   w2        load#2 2-5  load#3 5-7 (fails)  load#3 7-9            busy 3 + 2 + 2 =  7 s

   Job 0-10 = 10 s. Two workers at once at most, so 2 slots. Busy 15 of 20 = 75%. Parallelism 1.5.
   load: 6, 3, 2, 2. Total 13, p50 (2 + 3) / 2 = 2.5, max 6. p95 at rank 0.95 x 3 = 2.85: 3 + 0.85 x 3 = 5.55.
   Failed attempts: #3's first run, 2 s. Saved, low: 2 s over 2 slots = 1 s. High: that run is on the chain
   save 8-10 <- load 5-7 <- load 2-5, so 2 s (under 10 - 15 / 2 = 2.5). Chain: 2 + 2 + 3 + gap 1 = 8 s. */
export const worked = [
  ...task('load', 'w1', 0, 6, id(1), 1, 1),
  ...task('load', 'w2', 2, 3, id(2)),
  ...task('load', 'w2', 5, 2, id(3), 0, 0),
  ...task('load', 'w2', 7, 2, id(3)),
  ...task('save', 'w1', 8, 2, id(4)),
]
/* The same work without the failure: save starts when w1 is free. Job 0-8 = 8 s, 2 s (20%) faster. */
export const workedFixed = [
  ...task('load', 'w1', 0, 6, id(1), 1, 1),
  ...task('load', 'w2', 2, 3, id(2)),
  ...task('load', 'w2', 5, 2, id(3)),
  ...task('save', 'w1', 6, 2, id(4)),
]

export const json = (v: unknown) => Buffer.from(JSON.stringify(v))
export const sample = (name: string) => readFileSync(`public/samples/${name}.json.gz`)

export async function upload(page: Page, name: string, buffer: Buffer) {
  await page.locator('.empty input[type=file], .stat.action input[type=file]').first().setInputFiles({ name, mimeType: name.endsWith('.gz') ? 'application/gzip' : 'application/json', buffer })
}
export const stat = (page: Page, label: string | RegExp) => page.locator('.statbar .stat', { has: page.locator('span', { hasText: typeof label === 'string' ? new RegExp(label.replace(/[()]/g, '\\$&')) : label }) }).locator('b')
export const heading = (page: Page) => page.locator('.statbar h1')
export const card = (page: Page, title: string | RegExp) => page.locator('.diag', { has: page.locator('h3', { hasText: title }) })
export const tab = (page: Page, name: string) => page.getByRole('tab', { name }).click()

export async function exported(page: Page, kind: 'HTML' | 'JSON') {
  const wait = page.waitForEvent('download')
  await page.getByRole('button', { name: `Export ${kind}` }).click()
  const d = await wait
  return { name: d.suggestedFilename(), text: readFileSync(await d.path(), 'utf8') }
}
