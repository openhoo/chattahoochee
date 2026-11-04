import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  workers: process.env.CI ? 3 : 2,
  reporter: [['list'], ['html', { open: 'never' }], ['junit', { outputFile: 'test-results/e2e.xml' }]],
  use: { baseURL: 'http://127.0.0.1:1430', trace: 'retain-on-failure', screenshot: 'only-on-failure', video: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1360, height: 900 } } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'], viewport: { width: 1360, height: 900 } } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1360, height: 900 } } },
    { name: 'chromium-minimum', use: { ...devices['Desktop Chrome'], viewport: { width: 980, height: 640 } } },
    { name: 'webkit-minimum', use: { ...devices['Desktop Safari'], viewport: { width: 980, height: 640 } } },
  ],
  webServer: {
    command: 'npm run build && npm exec vite preview -- --host 127.0.0.1 --port 1430 --strictPort',
    url: 'http://127.0.0.1:1430',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
