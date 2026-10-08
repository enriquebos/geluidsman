import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  use: { baseURL: 'http://127.0.0.1:8001', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    ...(process.env.PLAYWRIGHT_FIREFOX === '1' ? [{ name: 'firefox', testMatch: /soundboard-layout\.spec\.ts/, use: { ...devices['Desktop Firefox'] } }] : []),
    { name: 'touch', use: { ...devices['Pixel 7'], defaultBrowserType: 'chromium' } },
  ],
  webServer: {
    command: 'poetry run python -m tests.browser_fixture',
    cwd: '..',
    url: 'http://127.0.0.1:8001/api/health',
    reuseExistingServer: false,
    timeout: 60000,
  },
})
