import { randomUUID } from 'node:crypto'
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test'
import { Client } from '../apps/server/scripts/harness'
import {
  browserLogin,
  expectHome,
  friendPassword,
  member,
  railTile,
  serverURL,
  signIn,
  signOut,
  type Identity,
} from './accounts'
import {
  Channel,
  FriendInvites,
  Room,
  defaultMascot,
  parseInvite,
} from '../packages/contracts/src/index'
import { sessionLabel } from '../packages/ui/src/sessionLabel'
import { useScratchServer } from './server'

const server = useScratchServer('api')

test('profile name persists for a password account', async ({ page }) => {
  await member(server.admin, page, 'profile', browserLogin)
  await expectHome(page)
  await page.getByRole('button', { name: 'Account security', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Account security', exact: true })).toBeVisible()
  await expect(page.getByText('@member.huddle.invalid')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expectHome(page)
  await page.getByRole('button', { name: 'Account security', exact: true }).click()
  await page.getByRole('button', { name: 'Profile', exact: true }).click()
  await expect(page.getByRole('button', { name: 'circle', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  const { user } = await page.evaluate(async () => {
    const response = await fetch('/api/account', { credentials: 'include' })
    return (await response.json()) as { user: { id: string } }
  })
  const assigned = defaultMascot(user.id)
  if (assigned.kind !== 'mascot') throw new Error('New accounts start with a mascot.')
  await expect(page.getByRole('button', { name: assigned.color, exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.getByLabel('Name', { exact: true }).fill('Updated profile owner')
  await page.getByRole('button', { name: 'Save profile', exact: true }).click()
  await page.reload()
  await page.getByRole('button', { name: 'Account security', exact: true }).click()
  await page.getByRole('button', { name: 'Profile', exact: true }).click()
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Updated profile owner')
})

test('default mascot colors are stable per user and differ between users', () => {
  expect(defaultMascot('user-a')).toEqual(defaultMascot('user-a'))
  const colors = ['user-a', 'user-b', 'user-c', 'user-d'].map((id) => {
    const avatar = defaultMascot(id)
    return avatar.kind === 'mascot' ? avatar.color : null
  })
  expect(new Set(colors).size).toBeGreaterThan(1)
})

test('session labels name the browser and platform, not the raw user agent', () => {
  const webkit = 'AppleWebKit/605.1.15 (KHTML, like Gecko)'
  const blink = 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
  const cases: [string | null, string][] = [
    [`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${blink}`, 'Chrome on Mac'],
    [`Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${blink} Edg/130.0.0.0`, 'Edge on Windows'],
    [
      `Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) ${webkit} Version/18.0 Mobile/15E148 Safari/604.1`,
      'Safari on iPhone',
    ],
    [`Mozilla/5.0 (Linux; Android 14; Pixel 8) ${blink}`, 'Chrome on Android'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0', 'Firefox on Linux'],
    [`Huddle desktop Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${webkit}`, 'Huddle desktop'],
    ['node', 'Session'],
    ['', 'Session'],
    [null, 'Session'],
  ]
  for (const [agent, label] of cases) expect(sessionLabel(agent)).toBe(label)
})

async function signedInElsewhere(browser: Browser, identity: Identity) {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.addInitScript((origin) => localStorage.setItem('huddle.server', origin), serverURL)
  await page.goto(browserLogin)
  await signIn(page, identity.username, identity.password)
  return { context, page }
}
async function openSecurity(page: Page) {
  await page.getByRole('button', { name: 'Account security', exact: true }).click()
  return page.locator('section', { has: page.getByRole('heading', { name: 'Active sessions' }) })
}
const sessionRows = (page: Page) => page.getByText(/^Signed in .*\. Expires /)
const signInHeading = (page: Page) => page.getByRole('heading', { name: 'Sign in to Huddle UI' })

test('signing out one session ends only that session', async ({ page, browser }) => {
  const identity = await member(server.admin, page, 'one-session', browserLogin)
  const laptop = await signedInElsewhere(browser, identity)
  const phone = await signedInElsewhere(browser, identity)
  try {
    const sessions = await openSecurity(page)
    await expect(sessionRows(page)).toHaveCount(3)
    await expect(sessions.getByText(/^Chrome on \w+ · This device$/)).toBeVisible()
    await sessions.getByRole('button', { name: 'Sign out', exact: true }).first().click()
    await expect(sessionRows(page)).toHaveCount(2)
    await expect(page.getByRole('dialog')).toHaveCount(1)
    await laptop.page.reload()
    await expect(signInHeading(laptop.page)).toBeVisible()
    await phone.page.reload()
    await expectHome(phone.page)
    await page.reload()
    await expectHome(page)
  } finally {
    await laptop.context.close()
    await phone.context.close()
  }
})

test('signing out all other sessions keeps only this device', async ({ page, browser }) => {
  const identity = await member(server.admin, page, 'all-sessions', browserLogin)
  const laptop = await signedInElsewhere(browser, identity)
  const phone = await signedInElsewhere(browser, identity)
  try {
    const sessions = await openSecurity(page)
    await expect(sessionRows(page)).toHaveCount(3)
    await sessions.getByRole('button', { name: 'Sign out all other sessions', exact: true }).click()
    await expect(sessionRows(page)).toHaveCount(1)
    await expect(sessions.getByText(/· This device$/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign out all other sessions' })).toHaveCount(0)
    for (const other of [laptop.page, phone.page]) {
      await other.reload()
      await expect(signInHeading(other)).toBeVisible()
    }
    await page.reload()
    await expectHome(page)
  } finally {
    await laptop.context.close()
    await phone.context.close()
  }
})

test('changing the password signs out other sessions and the new one signs in', async ({
  page,
  browser,
}) => {
  const identity = await member(server.admin, page, 'new-password', browserLogin)
  const laptop = await signedInElsewhere(browser, identity)
  try {
    await openSecurity(page)
    await expect(sessionRows(page)).toHaveCount(2)
    const form = page.locator('section', {
      has: page.getByRole('heading', { name: 'Change password' }),
    })
    const change = async (current: string, next: string, confirm = next) => {
      await form.getByLabel('Current password').fill(current)
      await form.getByLabel('New password', { exact: true }).fill(next)
      await form.getByLabel('Confirm new password').fill(confirm)
      await form.getByRole('button', { name: 'Change password', exact: true }).click()
    }
    await change(identity.password, 'brand-new-secret', 'brand-new-typo')
    await expect(form.getByRole('alert')).toHaveText('The new passwords don’t match.')
    await change('not-the-password', 'brand-new-secret')
    await expect(form.getByRole('alert')).toHaveText('Your current password is incorrect.')
    await laptop.page.reload()
    await expectHome(laptop.page)

    await change(identity.password, 'brand-new-secret')
    await expect(form.getByRole('status')).toHaveText(
      'Password changed. Your other sessions were signed out.',
    )
    await expect(form.getByLabel('Current password')).toHaveValue('')
    await expect(sessionRows(page)).toHaveCount(1)
    await laptop.page.reload()
    await expect(signInHeading(laptop.page)).toBeVisible()

    await page.reload()
    await expectHome(page)
    await signOut(page)
    const signInForm = page.locator('form').filter({
      has: page.getByRole('button', { name: 'Sign in', exact: true }),
    })
    await signInForm.getByLabel('Username').fill(identity.username)
    await signInForm.getByLabel('Password').fill(identity.password)
    await signInForm.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText(
      "That username or password isn't right. Check both and try again.",
    )
    await signIn(page, identity.username, 'brand-new-secret')
  } finally {
    await laptop.context.close()
  }
})

const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings', exact: true })
const backdropCorner = { x: 5, y: 5 }

async function friendClient() {
  const { value } = await server.admin.call('/api/friend-invite')
  const line = FriendInvites.parse(value).invites[0]
  if (!line) throw new Error('The server shared no invite.')
  const friend = new Client(serverURL)
  await friend.act({
    kind: 'account.join',
    code: parseInvite(line).code,
    username: 'settingsfriend',
    password: friendPassword,
  })
  return friend
}

async function expectThemedBlur(page: Page, dialog: Locator) {
  const backdrop = () =>
    dialog.evaluate((element) => {
      const style = getComputedStyle(element, '::backdrop')
      return {
        blur: style.backdropFilter,
        red: Number(style.backgroundColor.match(/\d+/)?.[0]),
      }
    })
  await page.emulateMedia({ colorScheme: 'light' })
  const light = await backdrop()
  expect(light.blur).toContain('blur')
  expect(light.red).toBeGreaterThan(200)
  await page.emulateMedia({ colorScheme: 'dark' })
  const dark = await backdrop()
  expect(dark.blur).toContain('blur')
  expect(dark.red).toBeLessThan(50)
}

test('the Settings window floats over a live chat and returns to it', async ({ page }) => {
  const room = Room.parse((await server.admin.call('/api/rooms', { name: 'Lounge' })).value)
  const channel = Channel.parse(
    (
      await server.admin.call('/api/channels', {
        roomId: room.id,
        name: 'general',
        kind: 'text',
      })
    ).value,
  )
  const friend = await friendClient()
  await page.addInitScript((origin) => localStorage.setItem('huddle.server', origin), serverURL)
  await page.goto(browserLogin)
  await signIn(page, 'uiadmin', 'admin-secret')
  await railTile(page, 'Lounge').click()

  const heading = page.getByRole('heading', { name: 'Welcome to #general' })
  const composer = page.getByRole('textbox', { name: 'Message #general' })
  const gear = page.getByRole('button', { name: 'Account security', exact: true })
  const dialog = settings(page)
  const draft = 'a thought I have not finished'
  await composer.fill(draft)

  await gear.click()
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('heading', { name: 'Account security' })).toBeVisible()
  await expect(heading).toBeAttached()
  await expectThemedBlur(page, dialog)

  const body = 'sent while Settings was open'
  await friend.call('/api/messages', { retryId: randomUUID(), channelId: channel.id, body })
  await expect(page.getByRole('main').getByText(body, { exact: true })).toBeAttached()

  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(heading).toBeVisible()
  await expect(composer).toHaveValue(draft)
  await expect(page.getByRole('main').getByText(body, { exact: true })).toBeVisible()
  await expect(gear).toBeFocused()

  await gear.click()
  await dialog.getByRole('button', { name: 'Close settings', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(gear).toBeFocused()

  await gear.click()
  await expect(dialog).toBeVisible()
  await page.mouse.click(backdropCorner.x, backdropCorner.y)
  await expect(dialog).toHaveCount(0)
  await expect(gear).toBeFocused()
  await expect(composer).toHaveValue(draft)

  const menu = page.getByRole('button', { name: 'Lounge menu', exact: true })
  await menu.click()
  await page.getByRole('button', { name: 'Security settings', exact: true }).click()
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(menu).toBeFocused()
})

test('leaving a field or the file picker does not close the Settings window', async ({ page }) => {
  await member(server.admin, page, 'dragger', browserLogin)
  await page.getByRole('button', { name: 'Account security', exact: true }).click()
  const dialog = settings(page)
  const field = dialog.getByLabel('Current password')
  await field.fill('typed before dragging')
  const box = await field.boundingBox()
  if (!box) throw new Error('The password field has no box.')

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(backdropCorner.x, backdropCorner.y, { steps: 5 })
  await page.mouse.up()
  await expect(dialog).toBeVisible()
  await expect(field).toHaveValue('typed before dragging')

  await page.mouse.move(backdropCorner.x, backdropCorner.y)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 })
  await page.mouse.up()
  await expect(dialog).toBeVisible()
  await expect(field).toHaveValue('typed before dragging')

  await dialog.getByRole('button', { name: 'Profile', exact: true }).click()
  await dialog.getByRole('button', { name: 'Photo', exact: true }).click()
  await dialog.getByLabel('Upload a photo').dispatchEvent('cancel', { bubbles: true })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Close settings', exact: true }).click()

  await page.getByRole('button', { name: 'New message', exact: true }).first().click()
  const small = page.getByRole('dialog')
  await expectThemedBlur(page, small)
  const edge = await small.boundingBox()
  if (!edge) throw new Error('The dialog has no box.')
  await page.mouse.click(edge.x + 6, edge.y + edge.height / 2)
  await expect(small).toBeVisible()
  await page.mouse.click(backdropCorner.x, backdropCorner.y)
  await expect(small).toHaveCount(0)
})

test('a saved profile name reaches the member list behind the Settings window', async ({
  page,
}) => {
  await member(server.admin, page, 'renamer', browserLogin)
  const members = page.getByRole('list', { name: 'Members', exact: true })
  await expect(members.getByText('renamer', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Account security', exact: true }).click()
  const dialog = settings(page)
  await dialog.getByRole('button', { name: 'Profile', exact: true }).click()
  await dialog.getByLabel('Name', { exact: true }).fill('Renamed friend')
  await dialog.getByRole('button', { name: 'Save profile', exact: true }).click()
  await expect(page.locator('.account-name').getByText('Renamed friend')).toBeVisible()
  await dialog.getByRole('button', { name: 'Close settings', exact: true }).click()

  await expect(members.getByText('Renamed friend', { exact: true })).toBeVisible()
  await expect(members.getByText('renamer', { exact: true })).toHaveCount(0)

  let release = () => {}
  const closed = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/access', async (route) => {
    const response = await route.fetch()
    await closed
    await route.fulfill({ response })
  })
  await page.getByRole('button', { name: 'Account security', exact: true }).click()
  await dialog.getByRole('button', { name: 'Profile', exact: true }).click()
  await dialog.getByLabel('Name', { exact: true }).fill('Closed while saving')
  const saving = page.waitForRequest('**/api/access')
  await dialog.getByRole('button', { name: 'Save profile', exact: true }).click()
  await saving
  await dialog.getByRole('button', { name: 'Close settings', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  release()

  await expect(page.locator('.account-name').getByText('Closed while saving')).toBeVisible()
  await expect(members.getByText('Closed while saving', { exact: true })).toBeVisible()
})
