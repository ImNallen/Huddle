import { test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import {
  accountLink,
  Client,
  migratedDatabase,
  startServer,
  type ServerProcess,
} from '../apps/server/scripts/harness'

const desktopPort = Number(process.env.HUDDLE_UI_DESKTOP_PORT ?? 1520)
export const serverPort = Number(process.env.HUDDLE_UI_SERVER_PORT ?? 3400)
export const serverURL = `http://localhost:${serverPort}`
export const browserApp = `${serverURL}/`
export const websocketURL = `ws://localhost:${serverPort + 1}`
export const setupCode = `ui-${randomUUID()}`
export const serverName = 'Huddle UI'

export function useScratchServer(setup: 'api' | 'ui', env: NodeJS.ProcessEnv = {}) {
  let server: ServerProcess | undefined
  let databaseUrl = ''
  let drop = async () => {}
  let admin: Client | undefined
  test.beforeAll(async () => {
    const database = await migratedDatabase()
    databaseUrl = database.url
    drop = database.drop
    server = await startServer({
      databaseUrl: database.url,
      port: serverPort,
      env: {
        ...env,
        SETUP_CODE: setupCode,
        TRUSTED_ORIGINS: [
          `http://127.0.0.1:${desktopPort}`,
          `http://localhost:${desktopPort}`,
        ].join(','),
      },
    })
    if (setup === 'api') {
      admin = new Client(serverURL, 'uiadmin@huddle.test')
      const stage = await admin.act({
        kind: 'account.setup',
        code: setupCode,
        serverName,
        name: 'uiadmin',
      })
      if (stage.kind !== 'ready') throw new Error('API setup did not finish.')
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
    link: (...args: string[]) => accountLink(databaseUrl, ...args),
  }
}
