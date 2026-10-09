import { test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import {
  Client,
  migratedDatabase,
  onboard,
  startServer,
  type ServerProcess,
} from '../apps/server/scripts/harness'

const desktopPort = Number(process.env.HUDDLE_UI_DESKTOP_PORT ?? 1520)
const serverPort = Number(process.env.HUDDLE_UI_SERVER_PORT ?? 3400)
export const serverURL = `http://localhost:${serverPort}`
export const browserLogin = `${serverURL}/login`
export const setupCode = `ui-${randomUUID()}`
export const serverName = 'Huddle UI'

export function useScratchServer(setup: 'api' | 'ui') {
  let server: ServerProcess | undefined
  let drop = async () => {}
  let admin: Client | undefined
  test.beforeAll(async () => {
    const database = await migratedDatabase()
    drop = database.drop
    server = await startServer({
      databaseUrl: database.url,
      port: serverPort,
      env: {
        SETUP_CODE: setupCode,
        TRUSTED_ORIGINS: [
          `http://127.0.0.1:${desktopPort}`,
          `http://localhost:${desktopPort}`,
          'tauri://localhost',
        ].join(','),
      },
    })
    if (setup === 'api') {
      admin = new Client(serverURL)
      await onboard(admin, { code: setupCode, serverName, name: 'Server admin' })
    }
  })
  test.afterAll(async () => {
    await server?.stop()
    await drop()
  })
  return {
    get admin() {
      if (!admin) throw new Error('This spec onboards through the UI and has no API admin.')
      return admin
    },
    logs: () => server?.logs() ?? '',
  }
}
