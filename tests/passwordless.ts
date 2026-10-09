import { expect, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { TOTP, Secret } from 'otpauth'
import { z } from 'zod'

export const serverURL = process.env.HUDDLE_UI_SERVER_URL ?? 'http://localhost:3000'
export const browserLogin = process.env.HUDDLE_UI_BROWSER_LOGIN ?? `${serverURL}/login`
const mailpitURL = process.env.HUDDLE_UI_MAILPIT_URL ?? 'http://127.0.0.1:8025'
const MailList = z.object({
  messages: z.array(z.object({ ID: z.string(), To: z.array(z.object({ Address: z.string() })) })),
})
const Mail = z.object({ Text: z.string() })
export type Identity = {
  email: string
  secret: string
  recovery: string[]
  name: string
  enrolledCode: string
}
export async function emailCode(page: Page, email: string, previous: Set<string> = new Set()) {
  let code: string | undefined
  await expect
    .poll(
      async () => {
        const response = await page.request.get(mailpitURL + '/api/v1/messages')
        const list = MailList.parse(await response.json())
        const message = list.messages.find(
          (item) =>
            !previous.has(item.ID) && item.To.some((recipient) => recipient.Address === email),
        )
        if (!message) return false
        const detail = await page.request.get(`${mailpitURL}/api/v1/message/${message.ID}`)
        const body = Mail.parse(await detail.json())
        code = body.Text.match(/\b\d{6}\b/)?.[0]
        return Boolean(code)
      },
      {
        timeout: 15000,
        message: 'SMTP delivered a verification code to the requested synthetic recipient',
      },
    )
    .toBe(true)
  if (!code) throw new Error('The verification email had no six-digit code.')
  return code
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
export async function signup(page: Page, name: string, path = '/') {
  const email = `${randomUUID()}@huddle.test`
  await page.addInitScript((origin) => localStorage.setItem('huddle.server', origin), serverURL)
  await page.goto(path)
  await page.getByLabel('Work email').fill(email)
  await page.getByRole('button', { name: 'Continue with email', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
  await page.getByLabel('Code', { exact: true }).fill(await emailCode(page, email))
  await page.getByRole('button', { name: 'Verify', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Set up your authenticator' })).toBeVisible()
  await expect(
    page.getByRole('img', { name: 'Scan this QR code with your authenticator app' }),
  ).toBeVisible()
  const secret = (await page.locator('.access-secret').textContent())?.trim()
  if (!secret) throw new Error('The authenticator setup key was not displayed.')
  const enrolledCode = totp(secret)
  await page.getByLabel('6-digit code').fill(enrolledCode)
  await page.getByRole('button', { name: 'Confirm and continue' }).click()
  await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toBeVisible()
  const recovery = await page.locator('.access-recovery-grid code').allTextContents()
  expect(recovery.length > 0).toBe(true)
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled()
  await page.getByRole('checkbox', { name: /I've saved these codes/ }).check()
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByRole('button', { name: 'Skip for now' }).click()
  await page.getByLabel('Display name').fill(name)
  await page.getByRole('button', { name: 'flower', exact: true }).click()
  await page.getByRole('button', { name: 'teal', exact: true }).click()
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  return { name, email, secret, recovery, enrolledCode } satisfies Identity
}
export async function sendEmail(page: Page, email: string) {
  const list = MailList.parse(
    await (await page.request.get(mailpitURL + '/api/v1/messages')).json(),
  )
  const previous = new Set(
    list.messages
      .filter((item) => item.To.some((recipient) => recipient.Address === email))
      .map((item) => item.ID),
  )
  await page.getByLabel('Work email').fill(email)
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = page.waitForResponse(
      (item) => item.url().endsWith('/api/access') && item.request().method() === 'POST',
    )
    await page.getByRole('button', { name: 'Continue with email', exact: true }).click()
    const result = await response
    if (result.ok()) return emailCode(page, email, previous)
    const error = z
      .object({ error: z.string(), retryAt: z.string().optional() })
      .parse(await result.json())
    if (error.error !== 'rate_limited' || !error.retryAt)
      throw new Error('The email challenge could not be sent.')
    await page.waitForTimeout(Math.max(0, Date.parse(error.retryAt) - Date.now()) + 100)
  }
  throw new Error('The server email cooldown did not clear at its reported time.')
}
export async function signin(page: Page, identity: Identity) {
  const code = await sendEmail(page, identity.email)
  await page.getByLabel('Code', { exact: true }).fill(code)
  await page.getByRole('button', { name: 'Verify', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Enter your authenticator code' })).toBeVisible()
  await page.getByLabel('Authenticator code').fill(await nextTotp(identity.secret))
  await page.getByRole('button', { name: 'Verify', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Choose a workspace' })).toBeVisible()
}
