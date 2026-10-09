import { expect, test } from '@playwright/test'
import { DeviceCode, DeviceToken, Session } from '../packages/contracts/src/index'
import { signup, serverURL } from './passwordless'

test('two colleagues join a private workspace, send, reconnect, and sign out', async ({
  browser,
  page,
}) => {
  const colleague = await browser.newContext()
  const second = await colleague.newPage()
  try {
    await signup(page, 'UI owner')
    await page.getByRole('button', { name: 'Create a workspace', exact: true }).click()
    await page.getByLabel('Workspace name').fill('UI studio')
    await page.getByRole('button', { name: 'Create workspace', exact: true }).last().click()
    await page.getByRole('button', { name: 'Create a channel', exact: true }).click()
    await page.getByLabel('Channel name').fill('general')
    await page.getByRole('button', { name: 'Create channel', exact: true }).last().click()
    await expect(page.getByRole('heading', { name: 'Welcome to #general' })).toBeVisible()
    await page.getByRole('button', { name: /Better together/ }).click()
    const code = await page.getByLabel('Invitation code').inputValue()
    await page.getByRole('button', { name: 'Close dialog' }).click()
    await signup(second, 'UI colleague')
    await second.getByRole('button', { name: 'Join with an invitation' }).click()
    await second.getByLabel('Invitation code').fill(code)
    await second.getByRole('button', { name: 'Join workspace', exact: true }).last().click()
    await expect(second.getByRole('heading', { name: 'Welcome to #general' })).toBeVisible()
    await expect(second.getByRole('status')).toHaveText('Connected')
    await page
      .getByRole('textbox', { name: 'Message #general' })
      .fill('A conversation between two real accounts.')
    await page.getByRole('button', { name: 'Send message' }).click()
    await expect(
      second.getByText('A conversation between two real accounts.', { exact: true }),
    ).toBeVisible()
    await colleague.setOffline(true)
    await page
      .getByRole('textbox', { name: 'Message #general' })
      .fill('Catch up when you are back.')
    await page.getByRole('button', { name: 'Send message' }).click()
    await colleague.setOffline(false)
    await expect(second.getByText('Catch up when you are back.', { exact: true })).toBeVisible({
      timeout: 15000,
    })
    await second.getByRole('textbox', { name: 'Message #general' }).fill('All caught up.')
    await second.getByRole('button', { name: 'Send message' }).click()
    await expect(page.getByText('All caught up.', { exact: true })).toBeVisible()
    const attempts: string[] = []
    await second.route('**/api/messages', async (route) => {
      if (route.request().method() === 'POST') {
        attempts.push(route.request().postData() ?? '')
        await route.abort('connectionfailed')
      } else await route.continue()
    })
    await second
      .getByRole('textbox', { name: 'Message #general' })
      .fill('Keep my message through a restart.')
    await second.getByRole('button', { name: 'Send message' }).click()
    await expect(second.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
    await second.reload()
    await second.getByRole('button', { name: /UI studio/ }).click()
    await expect(
      second.getByText('Keep my message through a restart.', { exact: true }),
    ).toBeVisible()
    await second.unroute('**/api/messages')
    second.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/api/messages'))
        attempts.push(request.postData() ?? '')
    })
    await second.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(
      page.getByText('Keep my message through a restart.', { exact: true }),
    ).toBeVisible()
    await expect(second.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0)
    expect(attempts).toHaveLength(2)
    expect(attempts[1]).toEqual(attempts[0])
    await page.screenshot({ path: 'test-results/conversation.png', fullPage: true })
    await second.getByRole('button', { name: 'Sign out', exact: true }).click()
    await expect(second.getByRole('heading', { name: /Sign in to/ })).toBeVisible()
  } finally {
    await colleague.close()
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
  await signup(
    page,
    'Device browser owner',
    `${serverURL}/login?redirect=${encodeURIComponent(redirect)}`,
  )
  await expect(page.getByLabel('Device code')).toHaveValue(code.user_code)
  await expect(page.getByRole('button', { name: 'Approve this desktop' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Check code' }).click()
  await expect(page.getByText(code.user_code, { exact: true })).toBeVisible()
  await expect(page.getByText('Huddle Desktop', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Approve this desktop' })).toBeDisabled()
  await page.getByRole('checkbox', { name: /I checked that this code/ }).check()
  await page.getByRole('button', { name: 'Approve this desktop' }).click()
  await expect(page.getByRole('heading', { name: 'You are connected' })).toBeVisible()
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
