import { expect, type Page } from '@playwright/test'
import { parseInvite, ServerInvite } from '../packages/contracts/src/index'
import { tailscale, type Client } from '../apps/server/scripts/harness'
import { serverURL, setupCode } from './server'

export { browserApp, serverURL } from './server'
export const loginOf = (person: string) => `${person}@huddle.test`
export async function actAs(page: Page, person: string) {
  await page.context().setExtraHTTPHeaders(tailscale(loginOf(person)))
}
export async function inviteCode(page: Page) {
  const payload = await page.evaluate(async () => {
    const response = await fetch('/api/invite')
    const body: unknown = await response.json().catch(() => null)
    if (!response.ok) throw new Error(`Invite request failed (${response.status}).`)
    return body
  })
  return parseInvite(ServerInvite.parse(payload).invite).code
}
export async function apiPost(page: Page, path: string, body: unknown) {
  return page.evaluate(
    async ({ path, body }) => {
      const access = await fetch('/api/access')
      const stage = (await access.json()) as { user: { id: string } }
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Huddle-User': stage.user.id },
        body: JSON.stringify(body),
      })
      if (!response.ok) throw new Error(`${path} failed with ${response.status}.`)
      return (await response.json()) as { id: string }
    },
    { path, body },
  )
}
export async function onboard(page: Page, person: string, serverName: string, path = '/') {
  await actAs(page, person)
  await page.addInitScript((origin) => localStorage.setItem('huddle.server', origin), serverURL)
  await page.goto(path)
  await expect(page.getByRole('heading', { name: 'Set up this server' })).toBeVisible()
  await page.getByLabel('Setup code').fill(setupCode)
  await page.getByLabel('Server name').fill(serverName)
  await expect(page.getByLabel('Your name')).toHaveValue(person)
  await page.getByRole('button', { name: 'Create the server', exact: true }).click()
  await skipProfile(page)
  await expectHome(page)
}
export async function join(page: Page, person: string, code: string, path = '/') {
  await actAs(page, person)
  await page.addInitScript(
    ({ origin, code }) => {
      localStorage.setItem('huddle.server', origin)
      if (sessionStorage.getItem('huddle.test.invited')) return
      sessionStorage.setItem('huddle.test.invited', 'true')
      localStorage.setItem(`huddle.join-code:${origin}`, code)
    },
    { origin: serverURL, code },
  )
  await page.goto(path)
  const form = page.locator('form').filter({
    has: page.getByRole('button', { name: 'Create account', exact: true }),
  })
  await expect(form.getByLabel('Your name')).toHaveValue(person)
  await form.getByRole('button', { name: 'Create account', exact: true }).click()
  await skipProfile(page)
  await expectHome(page)
}
export async function member(admin: Client, page: Page, person: string, path = '/') {
  const { response, value } = await admin.call('/api/invite')
  if (!response.ok) throw new Error(`Invite request failed (${response.status}).`)
  return join(page, person, parseInvite(ServerInvite.parse(value).invite).code, path)
}
export const rail = (page: Page) => page.getByRole('navigation', { name: 'Rooms', exact: true })
export const railTile = (page: Page, name: string) =>
  rail(page).getByRole('button', { name, exact: true })
export async function skipProfile(page: Page) {
  await expect(page.getByRole('heading', { name: 'Make it yours.', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Skip for now', exact: true }).click()
}
export async function expectHome(page: Page) {
  await expect(
    page.getByRole('heading', {
      level: 1,
      name: /^(Good (morning|afternoon|evening), |Your server is ready$|You’re in )/,
    }),
  ).toBeVisible()
}
