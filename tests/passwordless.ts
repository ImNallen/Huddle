import { expect, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { TOTP, Secret } from 'otpauth'
import { AccessError } from '../packages/contracts/src/index'
import { emailCode, invite, mailIds, type Client } from '../apps/server/scripts/harness'
import { serverName, serverURL, setupCode } from './server'

export { browserLogin, serverURL } from './server'
export type Identity = {
  email: string
  secret: string
  recovery: string[]
  name: string
  enrolledCode: string
}
export function totp(secret: string) {
  return new TOTP({
    secret: Secret.fromBase32(secret),
    digits: 6,
    period: 30,
    algorithm: 'SHA1',
  }).generate()
}
export async function nextTotp(secret: string) {
  const delay = 30000 - (Date.now() % 30000) + 50
  await new Promise((resolve) => setTimeout(resolve, delay))
  return totp(secret)
}
export const syntheticEmail = () => `${randomUUID()}@huddle.test`
async function open(page: Page, path: string) {
  await page.addInitScript((origin) => localStorage.setItem('huddle.server', origin), serverURL)
  await page.goto(path)
}
export async function onboard(
  page: Page,
  name: string,
  serverName: string,
  path = '/',
): Promise<Identity> {
  const email = syntheticEmail()
  await open(page, path)
  await expect(page.getByRole('heading', { name: 'Set up this server' })).toBeVisible()
  const previous = await mailIds(email)
  await page.getByLabel('Setup code').fill(setupCode)
  await page.getByLabel('Server name').fill(serverName)
  await page.getByLabel('Admin email').fill(email)
  await page.getByRole('button', { name: 'Continue with email', exact: true }).click()
  return verifyAndEnroll(page, email, name, previous, null)
}
export async function join(
  page: Page,
  email: string,
  name: string,
  path = '/',
  inviter?: { name: string; server: string },
) {
  await open(page, path)
  const previous = await mailIds(email)
  await page.getByLabel('Work email').fill(email)
  await page.getByRole('button', { name: 'Continue with email', exact: true }).click()
  return verifyAndEnroll(page, email, name, previous, inviter)
}
export async function member(admin: Client, page: Page, name: string, path = '/') {
  const email = syntheticEmail()
  await invite(admin, email)
  return join(page, email, name, path)
}
export async function signOut(page: Page) {
  await page.getByRole('button', { name: serverName, exact: true }).click()
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
}
export async function expectHome(page: Page) {
  await expect(
    page.getByRole('heading', {
      level: 1,
      name: /^(Good (morning|afternoon|evening), |Your server is ready$|You’re in )/,
    }),
  ).toBeVisible()
}
async function verifyAndEnroll(
  page: Page,
  email: string,
  name: string,
  previous: Set<string>,
  inviter: { name: string; server: string } | null | undefined,
) {
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
  await page.getByLabel('Verification code').fill(await emailCode(email, previous))
  await page.getByRole('button', { name: 'Verify', exact: true }).click()
  if (inviter !== null) {
    await expect(page.getByRole('heading', { name: /^You've joined / })).toBeVisible()
    if (inviter) {
      await expect(
        page.getByRole('heading', { name: `You've joined ${inviter.server}` }),
      ).toBeVisible()
      await expect(page.getByText(`${inviter.name} invited you`, { exact: true })).toBeVisible()
    }
    await page.getByRole('button', { name: 'Get started', exact: true }).click()
  }
  await expect(page.getByRole('heading', { name: 'Set up your authenticator' })).toBeVisible()
  await expect(
    page.getByRole('img', { name: 'Scan this QR code with your authenticator app' }),
  ).toBeVisible()
  const secret = await setupKey(page)
  const enrolledCode = totp(secret)
  await page.getByLabel('6-digit code').fill(enrolledCode)
  await page.getByRole('button', { name: 'Confirm and continue' }).click()
  await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toBeVisible()
  const recovery = await page
    .getByRole('list', { name: 'Recovery codes' })
    .locator('code')
    .allTextContents()
  expect(recovery.length > 0).toBe(true)
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled()
  await page.getByRole('checkbox', { name: /I've saved these codes/ }).check()
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByRole('button', { name: 'Skip for now' }).click()
  await expect(page.getByRole('heading', { name: 'Complete your profile' })).toBeVisible()
  await page.getByLabel('Name', { exact: true }).fill(name)
  await page.getByRole('button', { name: 'flower', exact: true }).click()
  await page.getByRole('button', { name: 'teal', exact: true }).click()
  await page.getByRole('button', { name: /^Continue to / }).click()
  return { name, email, secret, recovery, enrolledCode } satisfies Identity
}
export async function setupKey(page: Page) {
  const key = (await page.locator('.access-secret').textContent())?.replace(/\s/g, '')
  if (!key) throw new Error('The authenticator setup key was not displayed.')
  return key
}
export async function sendEmail(page: Page, email: string) {
  const previous = await mailIds(email)
  await page.getByLabel('Work email').fill(email)
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = page.waitForResponse(
      (item) => item.url().endsWith('/api/access') && item.request().method() === 'POST',
    )
    await page.getByRole('button', { name: 'Continue with email', exact: true }).click()
    const result = await response
    if (result.ok()) return emailCode(email, previous)
    const error = AccessError.parse(await result.json())
    if (error.error !== 'rate_limited' || !error.retryAt)
      throw new Error('The email challenge could not be sent.')
    await page.waitForTimeout(Math.max(0, Date.parse(error.retryAt) - Date.now()) + 100)
  }
  throw new Error('The server email cooldown did not clear at its reported time.')
}
export async function signin(page: Page, identity: Identity) {
  const code = await sendEmail(page, identity.email)
  await page.getByLabel('Verification code').fill(code)
  await page.getByRole('button', { name: 'Verify', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Enter your authenticator code' })).toBeVisible()
  await page.getByLabel('Authenticator code').fill(await nextTotp(identity.secret))
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expectHome(page)
}
