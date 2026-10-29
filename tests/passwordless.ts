import { expect, type Page } from '@playwright/test'
import { FriendInvites, parseInvite } from '../packages/contracts/src/index'
import type { Client } from '../apps/server/scripts/harness'
import { serverName, serverURL, setupCode } from './server'

export { browserLogin, serverURL } from './server'
export const serverPassword = 'server-secret'
export const friendPassword = 'friend-secret'
export type Identity = { username: string; password: string; name: string }

async function open(page: Page, path: string) {
  await page.addInitScript((origin) => localStorage.setItem('huddle.server', origin), serverURL)
  await page.goto(path)
  await expect(page.getByLabel('Username').first()).toBeVisible()
}
export async function inviteCode(page: Page) {
  const payload = await page.evaluate(async () => {
    const response = await fetch('/api/friend-invite', { credentials: 'include' })
    const body: unknown = await response.json().catch(() => null)
    if (!response.ok) throw new Error(`Invite request failed (${response.status}).`)
    return body
  })
  const line = FriendInvites.parse(payload).invites[0]
  if (!line) throw new Error('The server shared no invite.')
  return parseInvite(line).code
}
export async function onboard(
  page: Page,
  username: string,
  serverName: string,
  path = '/',
  password = serverPassword,
): Promise<Identity> {
  await open(page, path)
  await expect(page.getByRole('heading', { name: 'Set up this server' })).toBeVisible()
  await page.getByLabel('Setup code').fill(setupCode)
  await page.getByLabel('Server name').fill(serverName)
  await page.getByLabel('Username').fill(username)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Create the server', exact: true }).click()
  await expectHome(page)
  return { username, password, name: username }
}
export async function join(
  page: Page,
  username: string,
  code: string,
  path = '/',
  password = friendPassword,
): Promise<Identity> {
  await page.addInitScript(
    ({ origin, code }) => {
      localStorage.setItem('huddle.server', origin)
      localStorage.setItem(`huddle.join-code:${origin}`, code)
    },
    { origin: serverURL, code },
  )
  await page.goto(path)
  const form = page.locator('form').filter({
    has: page.getByRole('button', { name: 'Create account', exact: true }),
  })
  await expect(form.getByLabel('Username')).toBeVisible()
  await form.getByLabel('Username').fill(username)
  await form.getByLabel('Password').fill(password)
  await form.getByRole('button', { name: 'Create account', exact: true }).click()
  if (decodeURIComponent(path).includes('/device?'))
    await expect(page.getByRole('heading', { name: 'Sign in to Huddle Desktop?' })).toBeVisible()
  else await expectHome(page)
  return { username, password, name: username }
}
export async function member(admin: Client, page: Page, username: string, path = '/') {
  const { response, value } = await admin.call('/api/friend-invite')
  if (!response.ok) throw new Error(`Invite request failed (${response.status}).`)
  const line = FriendInvites.parse(value).invites[0]
  if (!line) throw new Error('The server shared no invite.')
  return join(page, username, parseInvite(line).code, path)
}
export async function signIn(page: Page, username: string, password: string) {
  const form = page.locator('form').filter({
    has: page.getByRole('button', { name: 'Sign in', exact: true }),
  })
  await form.getByLabel('Username').fill(username)
  await form.getByLabel('Password').fill(password)
  await form.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expectHome(page)
}
export async function signOut(page: Page, name = serverName) {
  await page.getByRole('button', { name: name, exact: true }).click()
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
