import { expect, test, type BrowserContext } from '@playwright/test'
import { tailscale } from '../apps/server/scripts/harness'
import { browserApp, expectHome, loginOf, member, serverURL } from './accounts'
import { serverName, useScratchServer } from './server'

const server = useScratchServer('api')

/** Playwright answers the preflight itself while a route is active. Its extra headers would otherwise
 *  fail the real preflight, which the integration suite checks directly. */
async function nativeShell(context: BrowserContext) {
  await context.route('**/*', (route) => route.continue())
  await context.addInitScript((origin) => {
    localStorage.setItem('huddle.server', origin)
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: { invoke: async () => null },
    })
  }, serverURL)
}

test('the desktop opens to Home with no stored credential and sends none', async ({
  page,
  browser,
}) => {
  await member(server.admin, page, 'desktopowner', browserApp)
  const context = await browser.newContext({
    extraHTTPHeaders: tailscale(loginOf('desktopowner')),
  })
  try {
    await nativeShell(context)
    const desktop = await context.newPage()
    const sent: Record<string, string>[] = []
    desktop.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/')) sent.push(request.headers())
    })
    await desktop.goto('/')
    await expectHome(desktop)
    expect(await context.cookies(serverURL)).toEqual([])
    expect(sent.length).toBeGreaterThan(0)
    expect(sent.filter((headers) => 'authorization' in headers || 'cookie' in headers)).toEqual([])
    const stored = await desktop.evaluate(() => JSON.stringify(localStorage))
    expect(stored).not.toContain(loginOf('desktopowner'))
    await desktop.reload()
    await expectHome(desktop)
    await expect(desktop.getByRole('banner')).toHaveCount(0)
    await expect(desktop.getByRole('navigation', { name: 'Rooms', exact: true })).toHaveJSProperty(
      'offsetTop',
      0,
    )
    await desktop.getByRole('button', { name: `${serverName} menu`, exact: true }).click()
    await expect(desktop.getByRole('button', { name: /sign out/i })).toHaveCount(0)
  } finally {
    await context.close()
  }
})

test('the browser build gives the conversation the full window height', async ({ page }) => {
  await member(server.admin, page, 'browserbar')
  await expect(page.locator('.titlebar')).toBeHidden()
  await expect(page.locator('.app')).toHaveJSProperty('offsetTop', 0)
  await expect(page.locator('.window-bar')).toHaveCount(0)
})

const macAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'
const windowsAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

test('the desktop draws one draggable window bar over every screen', async ({ page, browser }) => {
  await member(server.admin, page, 'windowbar', browserApp)
  const context = await browser.newContext({ userAgent: macAgent })
  try {
    await nativeShell(context)
    const desktop = await context.newPage()
    await desktop.goto('/')
    const bar = desktop.locator('.window-bar')
    await expect(
      desktop.getByRole('heading', { name: 'Open Huddle through Tailscale' }),
    ).toBeVisible()
    await expect(bar).toHaveAttribute('data-tauri-drag-region', 'true')
    await expect(bar).toHaveJSProperty('offsetHeight', 32)
    await expect(bar.getByRole('button')).toHaveCount(0)
    await context.setExtraHTTPHeaders(tailscale(loginOf('windowbar')))
    await desktop.getByRole('button', { name: 'Try again', exact: true }).click()
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
