import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: process.env.WEB_BASE_URL || 'http://localhost:9080',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
    // Traces can contain authorization headers. Keep test diagnostics local and ignored.
    trace: 'off',
    screenshot: 'only-on-failure',
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  },
  projects: [
    { name: 'unit', testMatch: '**/decimal.spec.ts' },
    { name: 'browser', testMatch: '**/*.browser.spec.ts', use: { browserName: 'chromium' } },
  ],
});
