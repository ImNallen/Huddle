import { existsSync } from 'node:fs'
import { defineConfig } from '@playwright/test'

if (existsSync('.env')) process.loadEnvFile('.env')
const desktopPort = Number(process.env.HUDDLE_UI_DESKTOP_PORT ?? 1520)
const serverPort = Number(process.env.HUDDLE_UI_SERVER_PORT ?? 3400)
export default defineConfig({
  testDir: './tests',
  timeout: 180000,
  workers: 1,
  use: {
    channel: process.env.PLAYWRIGHT_CHANNEL,
    baseURL: `http://127.0.0.1:${desktopPort}`,
    headless: true,
    viewport: { width: 1280, height: 860 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm --filter @huddle/desktop dev',
    url: `http://127.0.0.1:${desktopPort}`,
    env: {
      HUDDLE_DESKTOP_PORT: String(desktopPort),
      VITE_HUDDLE_DEV_SERVER: `http://localhost:${serverPort}`,
    },
    timeout: 30000,
    reuseExistingServer: false,
  },
})
