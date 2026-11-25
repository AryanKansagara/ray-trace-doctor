import { defineConfig, devices } from '@playwright/test'

// E2E runs against the production build (`npm run build`) served by `vite preview`.
const port = Number(process.env.E2E_PORT ?? 4196)

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  workers: 2,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: { contextOptions: { reducedMotion: 'reduce' }, baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure', serviceWorkers: 'block' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: { command: `node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 60_000 },
})
