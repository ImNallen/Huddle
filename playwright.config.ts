import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests',
  timeout: 60000,
  workers: 1,
  use: {
    channel: process.env.PLAYWRIGHT_CHANNEL,
    baseURL: 'http://127.0.0.1:1420',
    headless: true,
    viewport: { width: 1280, height: 860 },
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'pnpm --filter @huddle/server start',
      url: 'http://localhost:3000/api/health',
      timeout: 30000,
      reuseExistingServer: false,
    },
    {
      command: 'pnpm --filter @huddle/desktop dev',
      url: 'http://127.0.0.1:1420',
      timeout: 30000,
      reuseExistingServer: false,
    },
  ],
})
