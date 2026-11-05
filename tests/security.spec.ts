import { randomUUID } from 'node:crypto'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { Client } from '../apps/server/scripts/harness'
import { actAs, browserApp, expectHome, loginOf, member, railTile, serverURL } from './accounts'
import {
  Channel,
  defaultMascot,
  parseInvite,
  Room,
  ServerInvite,
} from '../packages/contracts/src/index'
import { serverName, useScratchServer } from './server'

const server = useScratchServer('api')

test('profile name persists, and Settings says who you are and that there is nothing to sign out of', async ({
  page,
}) => {
  await member(server.admin, page, 'profile', browserApp)
  await expectHome(page)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = settings(page)
  await expect(dialog.getByRole('heading', { name: 'Profile', exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Connection', exact: true }).click()
  await expect(dialog.getByRole('heading', { name: 'Connection', exact: true })).toBeVisible()
  await expect(dialog).toContainText(`Connected as ${loginOf('profile')} through Tailscale.`)
  await expect(dialog).toContainText("There's no sign-in and nothing to sign out of.")
  await expect(dialog).toContainText('To leave, disconnect Tailscale on this device.')
  await expect(dialog.getByRole('button', { name: /sign out/i })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expectHome(page)
  await page.getByRole('button', { name: `${serverName} menu`, exact: true }).click()
  await expect(page.getByRole('button', { name: /sign out/i })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.locator('.account').getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('button', { name: 'circle', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  const { user } = await page.evaluate(async () => {
    const response = await fetch('/api/account')
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
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
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

const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings', exact: true })
const backdropCorner = { x: 5, y: 5 }

async function friendClient(person = 'settingsfriend') {
  const { value } = await server.admin.call('/api/invite')
  const friend = new Client(serverURL, loginOf(person))
  await friend.act({
    kind: 'account.join',
    code: parseInvite(ServerInvite.parse(value).invite).code,
    name: person,
  })
  return friend
}
async function openAsAdmin(page: Page) {
  await actAs(page, 'uiadmin')
  await page.goto(browserApp)
  await expectHome(page)
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
  await openAsAdmin(page)
  await railTile(page, 'Lounge').click()

  const heading = page.getByRole('heading', { name: 'Welcome to #general' })
  const composer = page.getByRole('textbox', { name: 'Message #general' })
  const gear = page.getByRole('button', { name: 'Settings', exact: true })
  const dialog = settings(page)
  const draft = 'a thought I have not finished'
  await composer.fill(draft)

  await gear.click()
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('heading', { name: 'Profile' })).toBeVisible()
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
  await page.locator('#server-menu').getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(menu).toBeFocused()
})

test('messages behind a dialog stay unread until it closes', async ({ page }) => {
  const room = Room.parse((await server.admin.call('/api/rooms', { name: 'Study' })).value)
  const channel = Channel.parse(
    (
      await server.admin.call('/api/channels', {
        roomId: room.id,
        name: 'notes',
        kind: 'text',
      })
    ).value,
  )
  const friend = await friendClient('readfriend')
  await openAsAdmin(page)
  await railTile(page, 'Study').click()
  await expect(page.getByRole('heading', { name: 'Welcome to #notes' })).toBeVisible()

  const row = page
    .getByRole('navigation', { name: 'Study channels', exact: true })
    .getByRole('button', { name: /^notes/ })
  let reads = 0
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/read') reads += 1
  })
  const openers = [
    page.getByRole('button', { name: 'Settings', exact: true }),
    page.getByRole('button', { name: 'Create room', exact: true }),
  ]
  for (const [index, opener] of openers.entries()) {
    await opener.click()
    await expect(page.getByRole('dialog')).toBeVisible()
    const before = reads
    const body = `sent behind dialog ${index}`
    await friend.call('/api/messages', { retryId: randomUUID(), channelId: channel.id, body })
    await expect(page.getByRole('main').getByText(body, { exact: true })).toBeAttached()
    await expect(row).toHaveAccessibleName('notes unread')
    // The read would be sent 300ms after the message arrives.
    await page.waitForTimeout(600)
    expect(reads).toBe(before)
    await expect(row).toHaveAccessibleName('notes unread')

    const read = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/read',
    )
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await read
    await expect(row).toHaveAccessibleName('notes')
  }
})

test('leaving a field or the file picker does not close the Settings window', async ({ page }) => {
  await member(server.admin, page, 'dragger', browserApp)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = settings(page)
  const field = dialog.getByLabel('Name', { exact: true })
  await field.fill('typed before dragging')
  const box = await field.boundingBox()
  if (!box) throw new Error('The name field has no box.')

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
  await member(server.admin, page, 'renamer', browserApp)
  const members = page.getByRole('list', { name: 'Members', exact: true })
  await expect(members.getByText('renamer', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = settings(page)
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
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
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

test('a new identity under a running page never sends what the old one typed', async ({ page }) => {
  const room = Room.parse((await server.admin.call('/api/rooms', { name: 'Handover' })).value)
  const channel = Channel.parse(
    (
      await server.admin.call('/api/channels', {
        roomId: room.id,
        name: 'desk',
        kind: 'text',
      })
    ).value,
  )
  await member(server.admin, page, 'switcher', browserApp)
  await railTile(page, 'Handover').click()
  const composer = page.getByRole('textbox', { name: 'Message #desk' })
  const body = `typed before the switch ${randomUUID()}`
  await composer.fill(body)

  await actAs(page, 'uiadmin')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.locator('.account-name > strong')).toHaveText('uiadmin')
  await expectHome(page)
  await expect(page.getByText(body, { exact: true })).toHaveCount(0)
  const history = await server.admin.call(`/api/messages?channelId=${channel.id}`)
  expect(JSON.stringify(history.value)).not.toContain(body)

  await actAs(page, 'switcher')
  await page.reload()
  await expect(page.locator('.account-name > strong')).toHaveText('switcher')
  await railTile(page, 'Handover').click()
  await expect(page.getByText(body, { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0)
  await expect
    .poll(async () =>
      JSON.stringify((await server.admin.call(`/api/messages?channelId=${channel.id}`)).value),
    )
    .toContain(body)
})

test('losing Tailscale under a running page shows why instead of a broken chat', async ({
  page,
}) => {
  await member(server.admin, page, 'dropped', browserApp)
  await page.context().setExtraHTTPHeaders({})
  await page.locator('.account').getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Open Huddle through Tailscale' })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('Nothing has changed yet.')
  await actAs(page, 'dropped')
  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  await expectHome(page)
})
