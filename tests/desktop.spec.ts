import { expect, test, type BrowserContext } from '@playwright/test'
import { Client } from '../apps/server/scripts/harness'
import { browserLogin, expectHome, member, serverURL, signIn } from './accounts'
import { serverName, useScratchServer } from './server'

const server = useScratchServer('api')

async function nativeShell(context: BrowserContext) {
  await context.addInitScript((origin) => {
    localStorage.setItem('huddle.server', origin)
    const slot = 'huddle-test-keychain'
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: { token?: string }) => {
          if (command === 'load_token') return sessionStorage.getItem(slot)
          if (command === 'save_token' && args.token) sessionStorage.setItem(slot, args.token)
          if (command === 'clear_token') sessionStorage.removeItem(slot)
          return null
        },
      },
    })
  }, serverURL)
}

test('the desktop signs in with a password and keeps its bearer in the keychain', async ({
  page,
  browser,
}) => {
  const identity = await member(server.admin, page, 'desktopowner', browserLogin)
  const context = await browser.newContext()
  try {
    await nativeShell(context)
    const desktop = await context.newPage()
    await desktop.goto('/')
    await signIn(desktop, identity.username, identity.password)
    const keychain = () => desktop.evaluate(() => sessionStorage.getItem('huddle-test-keychain'))
    expect(await keychain()).toBeTruthy()
    expect(await context.cookies(serverURL)).toEqual([])
    await desktop.reload()
    await expectHome(desktop)
    await desktop.getByRole('button', { name: serverName, exact: true }).click()
    await desktop.getByRole('button', { name: 'Sign out', exact: true }).click()
    await expect(desktop.getByRole('heading', { name: `Sign in to ${serverName}` })).toBeVisible()
    expect(await keychain()).toBeNull()
  } finally {
    await context.close()
  }
})

test('a failed keychain cleanup during a server switch leaves Back usable', async ({
  page,
  browser,
}) => {
  const identity = await member(server.admin, page, 'switchowner', browserLogin)
  const native = new Client(serverURL, true)
  await native.act({
    kind: 'account.signin',
    username: identity.username,
    password: identity.password,
  })
  const context = await browser.newContext()
  await context.addInitScript(
    ({ origin, credential }) => {
      localStorage.setItem('huddle.server', origin)
      Object.assign(window, {
        isTauri: true,
        __TAURI_INTERNALS__: {
          invoke: async (command: string) => {
            if (command === 'load_token') return credential
            if (command === 'clear_token') throw new Error('Fixture keychain clear failed')
            return undefined
          },
        },
      })
    },
    { origin: serverURL, credential: native.token },
  )
  try {
    const desktop = await context.newPage()
    await desktop.goto('/')
    await expectHome(desktop)
    await desktop.getByRole('button', { name: serverName, exact: true }).click()
    await desktop.getByRole('button', { name: 'Switch server', exact: true }).click()
    await desktop.getByLabel('Server address').fill(serverURL)
    await desktop.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(desktop.getByRole('alert')).toHaveText('Fixture keychain clear failed')
    await desktop.getByRole('button', { name: 'Back', exact: true }).click()
    await expectHome(desktop)
  } finally {
    await context.close()
  }
})
