import { expect, test, type BrowserContext } from '@playwright/test'
import { Client } from '../apps/server/scripts/harness'
import { serverInitials } from '../packages/contracts/src/index'
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
    await expect(desktop.getByRole('banner')).toHaveCount(0)
    await expect(desktop.getByRole('navigation', { name: 'Rooms', exact: true })).toHaveJSProperty(
      'offsetTop',
      0,
    )
    await desktop.getByRole('button', { name: 'Account security', exact: true }).click()
    await expect(desktop.getByText('Huddle desktop · This device', { exact: true })).toBeVisible()
    await desktop.getByRole('button', { name: 'Close settings', exact: true }).click()
    await desktop.getByRole('button', { name: `${serverName} menu`, exact: true }).click()
    await desktop.getByRole('button', { name: 'Sign out', exact: true }).click()
    await expect(desktop.getByRole('heading', { name: `Sign in to ${serverName}` })).toBeVisible()
    expect(await keychain()).toBeNull()
  } finally {
    await context.close()
  }
})

test('the browser build keeps the app title bar', async ({ page }) => {
  await member(server.admin, page, 'browserbar')
  await expect(page.getByRole('banner')).toHaveText(`${serverInitials(serverName)}${serverName}`)
  await expect(page.locator('.window-bar')).toHaveCount(0)
})

const macAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'
const windowsAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

test('the desktop draws one draggable window bar over every screen', async ({ page, browser }) => {
  const identity = await member(server.admin, page, 'windowbar', browserLogin)
  const context = await browser.newContext({ userAgent: macAgent })
  try {
    await nativeShell(context)
    const desktop = await context.newPage()
    await desktop.goto('/')
    const bar = desktop.locator('.window-bar')
    await expect(desktop.getByRole('heading', { name: `Sign in to ${serverName}` })).toBeVisible()
    await expect(bar).toHaveAttribute('data-tauri-drag-region', 'true')
    await expect(bar).toHaveJSProperty('offsetHeight', 32)
    await expect(bar.getByRole('button')).toHaveCount(0)
    await signIn(desktop, identity.username, identity.password)
    await expectHome(desktop)
    await expect(bar).toBeVisible()
    await expect(desktop.getByRole('banner')).toHaveCount(0)
    const nav = await desktop.getByRole('navigation', { name: 'Rooms', exact: true }).boundingBox()
    expect(nav?.y).toBe(32)
    const fits = await desktop.evaluate(
      () => document.documentElement.scrollHeight <= window.innerHeight,
    )
    expect(fits).toBe(true)
    await desktop.getByRole('button', { name: 'Switch server', exact: true }).click()
    await expect(bar).toHaveText('Huddle')
  } finally {
    await context.close()
  }
})

test('outside macOS the window bar draws working window controls', async ({ browser }) => {
  const context = await browser.newContext({ userAgent: windowsAgent })
  try {
    await context.addInitScript((origin) => {
      localStorage.setItem('huddle.server', origin)
      const calls: string[] = []
      Object.assign(window, {
        isTauri: true,
        windowCalls: calls,
        __TAURI_INTERNALS__: {
          metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
          invoke: async (command: string) => {
            calls.push(command)
            return null
          },
        },
      })
    }, serverURL)
    const desktop = await context.newPage()
    await desktop.goto('/')
    const controls = desktop.locator('.window-controls').getByRole('button')
    await expect(controls).toHaveCount(3)
    for (const name of ['Minimize', 'Maximize', 'Close window'])
      await desktop.getByRole('button', { name, exact: true }).click()
    const calls = await desktop.evaluate(
      () => (window as unknown as { windowCalls: string[] }).windowCalls,
    )
    expect(calls).toEqual(
      expect.arrayContaining([
        'plugin:window|minimize',
        'plugin:window|toggle_maximize',
        'plugin:window|close',
      ]),
    )
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
