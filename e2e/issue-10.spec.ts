import { readFileSync } from 'node:fs'
import { expect, test } from './fixtures.ts'

test('#10 no page requests another origin', async ({ page, outside }) => {
  for (const path of ['/', '/app?sample=skew']) {
    await page.goto(path)
    await expect(page.getByRole('contentinfo')).toBeVisible()
    await page.waitForLoadState('networkidle')
  }
  expect(outside).toEqual([])
})

test('#10 the deployed Content-Security-Policy names no other origin, and the fonts load under it', async ({ page, outside }) => {
  const csp: string = JSON.parse(readFileSync('vercel.json', 'utf8')).headers[0].headers[0].value
  expect(csp).not.toMatch(/https?:/)
  await page.route((url) => url.pathname === '/' || url.pathname === '/app', async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': csp } })
  })
  for (const path of ['/', '/app?sample=skew']) {
    await page.goto(path)
    await expect(page.getByRole('contentinfo')).toBeVisible()
    await expect.poll(() => page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/["']/g, '')).sort())).toEqual(['Geist', 'Geist Mono'])
  }
  // Every font file the stylesheet names is served as a font, not as the page the server falls back to.
  const urls = [...new Set([...readFileSync('src/styles.css', 'utf8').matchAll(/url\((\/fonts\/[^)]+)\)/g)].map((m) => m[1]))]
  expect(urls).toHaveLength(11)
  for (const u of urls) expect((await (await page.request.get(u)).body()).subarray(0, 4).toString(), u).toBe('wOF2')
  expect(outside).toEqual([])
})
