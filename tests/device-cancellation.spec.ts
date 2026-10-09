import { expect, test } from '@playwright/test'
import { DeviceCode, DeviceToken, Session } from '../packages/contracts/src/index'
import { expectHome, member, serverURL } from './passwordless'
import { serverName, useScratchServer } from './server'

const server = useScratchServer('api')

test('cancelling a redeemed native device token before admission never saves or adopts it', async ({
  page,
  browser,
}) => {
  await member(server.admin, page, 'Cancellation owner', `${serverURL}/login`)
  console.log('PASS cancellation test browser account is ready')
  const context = await browser.newContext()
  await context.addInitScript((origin) => {
    localStorage.setItem('huddle.server', origin)
    const writes: string[] = []
    Object.assign(window, {
      isTauri: true,
      huddleTestWrites: writes,
      huddleTestBrowser: '',
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: { url?: string; token?: string }) => {
          if (command === 'load_token') return null
          if (command === 'save_token' && args.token) writes.push(args.token)
          if (command === 'plugin:opener|open_url')
            Object.assign(window, { huddleTestBrowser: args.url })
          return undefined
        },
      },
    })
  }, serverURL)
  const desktop = await context.newPage()
  let release: () => void = () => undefined
  const paused = new Promise<void>((resolve) => {
    release = resolve
  })
  let bearerReads = 0
  await desktop.route(`${serverURL}/api/access`, async (route) => {
    if (route.request().headers().authorization) {
      bearerReads += 1
      if (bearerReads === 1) {
        await paused
      }
    }
    await route.continue().catch(() => undefined)
  })
  try {
    await desktop.goto('/')
    console.log('PASS cancellation test native IPC fixture opened')
    await desktop.getByRole('button', { name: 'Sign in in your browser', exact: true }).click()
    await expect(desktop.getByRole('heading', { name: 'Sign in in your browser' })).toBeVisible()
    console.log('PASS cancellation test desktop waits for approval')
    const target = await desktop.evaluate<string>('window.huddleTestBrowser')
    expect(new URL(target).origin).toBe(serverURL)
    await page.goto(target)
    console.log('PASS cancellation test browser returned to device approval')
    await page.getByRole('checkbox', { name: /I checked that this code/ }).check()
    await page.getByRole('button', { name: 'Approve this desktop', exact: true }).click()
    console.log('PASS cancellation test browser explicitly approved')
    await expect.poll(() => bearerReads, { timeout: 15000 }).toBe(1)
    console.log('PASS cancellation test candidate admission request is paused')
    await desktop.getByRole('button', { name: 'Cancel sign-in', exact: true }).click()
    await expect(desktop.getByLabel('Work email')).toBeVisible()
    release()
    expect(await desktop.evaluate<number>('window.huddleTestWrites.length')).toBe(0)
    expect(bearerReads).toBe(1)
    await expect(
      desktop.getByRole('heading', { name: /^Good (morning|afternoon|evening), / }),
    ).toHaveCount(0)
  } finally {
    release()
    await context.close()
  }
})

test('a failed keychain cleanup during a server switch leaves Back usable', async ({
  page,
  browser,
}) => {
  await member(server.admin, page, 'Server switch owner', `${serverURL}/login`)
  const code = DeviceCode.parse(
    await (
      await page.request.post(`${serverURL}/api/auth/device/code`, {
        headers: { Origin: serverURL },
        data: { client_id: 'huddle-desktop' },
      })
    ).json(),
  )
  await page.goto(code.verification_uri_complete ?? code.verification_uri)
  await page.getByRole('checkbox', { name: /I checked that this code/ }).check()
  await page.getByRole('button', { name: 'Approve this desktop', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'You’re connected' })).toBeVisible()
  const token = DeviceToken.parse(
    await (
      await page.request.post(`${serverURL}/api/auth/device/token`, {
        headers: { Origin: serverURL },
        data: {
          client_id: 'huddle-desktop',
          device_code: code.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        },
      })
    ).json(),
  )
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
    { origin: serverURL, credential: token.access_token },
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

test('the browser claims a device code and requires explicit approval', async ({ page }) => {
  const codeResponse = await page.request.post(serverURL + '/api/auth/device/code', {
    headers: { Origin: serverURL },
    data: { client_id: 'huddle-desktop' },
  })
  expect(codeResponse.ok()).toBeTruthy()
  const rawCode: unknown = await codeResponse.json()
  const code = DeviceCode.parse(rawCode)
  const redirect = `/device?user_code=${encodeURIComponent(code.user_code)}`
  await member(
    server.admin,
    page,
    'Device browser owner',
    `${serverURL}/login?redirect=${encodeURIComponent(redirect)}`,
  )
  await expect(page.getByText(code.user_code, { exact: true })).toBeVisible()
  await expect(page.getByLabel('Device code')).toHaveCount(0)
  await expect(page.getByText('Huddle Desktop', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Approve this desktop' })).toBeDisabled()
  await page.getByRole('checkbox', { name: /I checked that this code/ }).check()
  await page.getByRole('button', { name: 'Approve this desktop' }).click()
  await expect(page.getByRole('heading', { name: 'You’re connected' })).toBeVisible()
  await expect(page.getByText('Device browser owner', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Review account security' })).toHaveAttribute(
    'href',
    '/login?settings=security',
  )
  await page.screenshot({ path: '/tmp/devshot/connected.png' })
  await page.goto(serverURL + '/device')
  await page.getByLabel('Device code').fill(code.user_code)
  await page.getByRole('button', { name: 'Check code' }).click()
  await expect(page.getByRole('heading', { name: 'You’re connected' })).toBeVisible()
  const response = await fetch(serverURL + '/api/auth/device/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: serverURL },
    body: JSON.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: code.device_code,
      client_id: 'huddle-desktop',
    }),
  })
  const tokenValue: unknown = await response.json()
  const token = DeviceToken.parse(tokenValue)
  const sessionResponse = await fetch(serverURL + '/api/auth/get-session', {
    headers: { Authorization: `Bearer ${token.access_token}` },
  })
  const sessionValue: unknown = await sessionResponse.json()
  expect(Session.parse(sessionValue).user.name).toBe('Device browser owner')
})
