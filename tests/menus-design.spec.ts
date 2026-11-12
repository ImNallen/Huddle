import { expect, test, type Page } from '@playwright/test'
import { Channel, Room, ServerInvite, parseInvite } from '../packages/contracts/src/index'
import { Client } from '../apps/server/scripts/harness'
import { actAs, browserApp, expectHome, railTile, serverURL } from './accounts'
import { useScratchServer } from './server'

const server = useScratchServer('api')
async function both(page: Page, name: string) {
  await page.mouse.move(0, 0)
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
    await page.evaluate(() => document.fonts.ready)
    const path = test.info().outputPath(`${name}-${colorScheme}.png`)
    await page.screenshot({ path, animations: 'disabled' })
    await test.info().attach(`${name}-${colorScheme}`, { path, contentType: 'image/png' })
  }
}

test('quiet menus and emoji popovers support real actions, keyboard dismissal and both themes', async ({
  page,
  browser,
}) => {
  page.setDefaultTimeout(10000)
  await server.admin.act({
    kind: 'profile.save',
    profile: { name: 'Adam Nilsson', avatar: { kind: 'mascot', shape: 'circle', color: 'teal' } },
  })
  const room = Room.parse((await server.admin.call('/api/rooms', { name: 'The studio' })).value)
  Channel.parse(
    (await server.admin.call('/api/channels', { roomId: room.id, name: 'general', kind: 'text' }))
      .value,
  )
  Channel.parse(
    (await server.admin.call('/api/channels', { roomId: room.id, name: 'Lounge', kind: 'voice' }))
      .value,
  )
  const invite = ServerInvite.parse((await server.admin.call('/api/invite')).value)
  const friend = new Client(serverURL, 'maya@huddle.test')
  await friend.act({
    kind: 'account.join',
    code: parseInvite(invite.invite).code,
    name: 'Maya Lind',
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await actAs(page, 'uiadmin')
  await page.goto(browserApp)
  await expectHome(page)
  const serverButton = page.getByRole('button', { name: 'Huddle UI menu', exact: true })
  for (const width of [1440, 640]) {
    await page.setViewportSize({ width, height: 900 })
    const insets = await serverButton.evaluate((button) => {
      const title = button.querySelector('strong')?.getBoundingClientRect()
      const chevron = button.querySelector('svg')?.getBoundingClientRect()
      if (!title || !chevron) throw new Error('The server menu is missing its labels.')
      const box = button.getBoundingClientRect()
      return { left: title.left - box.left, right: box.right - chevron.right }
    })
    expect(insets.left).toBeGreaterThanOrEqual(12)
    expect(insets.right).toBeGreaterThanOrEqual(12)
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await serverButton.focus()
  await page.keyboard.press('Enter')
  const menu = page.locator('#server-menu')
  await expect(menu.getByRole('button', { name: 'Members', exact: true })).toBeFocused()
  await expect(menu.getByRole('button')).toHaveText([
    'Members',
    'Create a room',
    'Rename server…',
    'Settings',
  ])
  await page.keyboard.press('End')
  await expect(menu.getByRole('button', { name: 'Settings', exact: true })).toBeFocused()
  await both(page, 'server-menu')
  await page.keyboard.press('Escape')
  await expect(menu).not.toBeVisible()
  await expect(serverButton).toBeFocused()
  await serverButton.click()
  await menu.getByRole('button', { name: 'Members', exact: true }).click()
  await expect(
    page.getByRole('main').getByRole('heading', { name: 'People on Huddle UI', exact: true }),
  ).toBeVisible()

  await railTile(page, 'The studio').click()
  const roomButton = page.getByRole('button', { name: 'The studio menu', exact: true })
  const composer = page.getByRole('textbox', { name: 'Message #general', exact: true })
  await composer.fill('A little celebration today')
  await roomButton.click()
  await expect(menu).toHaveCSS('width', '244px')
  await expect(menu.getByRole('button')).toHaveText([
    'Create a channel',
    'Create a room',
    'Rename room…',
    'Delete room…',
    'Settings',
  ])
  await both(page, 'room-menu')
  await page.keyboard.press('ArrowDown')
  await expect(menu.getByRole('button', { name: 'Create a room', exact: true })).toBeFocused()
  await page.keyboard.press('Home')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: 'Add a channel', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(roomButton).toBeFocused()
  await expect(composer).toHaveValue('A little celebration today')
  await roomButton.click()
  await composer.click()
  await expect(menu).not.toBeVisible()
  await expect(composer).toBeFocused()

  const channelOptions = page.getByRole('button', { name: 'Channel options', exact: true })
  const channelMenu = page.locator('#channel-menu')
  await channelOptions.focus()
  await page.keyboard.press('Enter')
  await expect(channelMenu.getByRole('button')).toHaveText([
    'Rename channel…',
    'Delete channel…',
    'Settings',
  ])
  await expect(channelMenu.getByRole('button', { name: 'Rename channel…' })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(channelMenu.getByRole('button', { name: 'Delete channel…' })).toBeFocused()
  await both(page, 'channel-menu')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: 'Delete #general?', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(channelOptions).toBeFocused()
  await expect(composer).toHaveValue('A little celebration today')
  await page
    .getByRole('navigation', { name: 'The studio channels', exact: true })
    .getByRole('button', { name: 'Lounge' })
    .click()
  await channelOptions.click()
  await expect(channelMenu.getByRole('button')).toHaveText([
    'Rename channel…',
    'Delete channel…',
    'Settings',
  ])
  await both(page, 'voice-channel-menu')
  await page.keyboard.press('End')
  await expect(channelMenu.getByRole('button', { name: 'Settings', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(channelOptions).toBeFocused()
  await page
    .getByRole('navigation', { name: 'The studio channels', exact: true })
    .getByRole('button', { name: 'general' })
    .click()

  await composer.evaluate((field: HTMLTextAreaElement) => field.setSelectionRange(9, 20))
  const emojiButton = page.getByRole('button', { name: 'Add emoji', exact: true })
  const picker = page.getByRole('group', { name: 'Emoji picker', exact: true })
  const search = picker.getByRole('searchbox', { name: 'Search emoji', exact: true })
  await emojiButton.click()
  await expect(search).toBeFocused()
  await expect(picker).toHaveCSS('width', '360px')
  await expect(picker).toHaveCSS('height', '369px')
  await expect(picker.getByRole('button', { name: 'Insert 😊', exact: true })).toHaveCSS(
    'font-family',
    '"Noto Emoji Variable", sans-serif',
  )
  const pickerBox = await picker.boundingBox()
  const composerBox = await page.locator('.composer').boundingBox()
  if (!pickerBox || !composerBox) throw new Error('The picker or composer is missing.')
  expect(pickerBox.y + pickerBox.height).toBeLessThanOrEqual(composerBox.y - 8)
  await both(page, 'emoji-picker')
  await search.fill('mountain coffee')
  await expect(picker.getByRole('status')).toContainText('No emoji found')
  await search.press('Enter')
  await expect(page.getByRole('article')).toHaveCount(0)
  await both(page, 'emoji-empty')
  await picker.getByRole('button', { name: 'Clear search', exact: true }).click()
  await expect(search).toBeFocused()
  await search.fill('sparkles')
  await expect(picker.locator('.emoji-name')).toContainText('Sparkles')
  await picker.getByRole('button', { name: 'Insert ✨', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(composer).toHaveValue('A little ✨ today')
  await expect(composer).toBeFocused()
  await expect(composer).toHaveJSProperty('selectionStart', 10)
  await emojiButton.click()
  await picker.getByRole('button', { name: 'Recent', exact: true }).click()
  await expect(picker.getByRole('button', { name: 'Insert ✨', exact: true })).toBeVisible()
  await picker.getByRole('button', { name: 'Nature', exact: true }).click()
  await expect(picker.getByRole('button', { name: 'Insert 🦋', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(emojiButton).toBeFocused()
  await expect(composer).toHaveValue('A little ✨ today')

  await page.getByRole('button', { name: 'Member list', exact: true }).click()
  const actions = page.getByRole('button', { name: 'Actions for Maya Lind', exact: true })
  await page.getByRole('button', { name: 'View Maya Lind', exact: true }).click({ button: 'right' })
  const memberMenu = page.getByRole('group', { name: 'Maya Lind actions', exact: true })
  await expect(memberMenu).toHaveCSS('width', '224px')
  await expect(memberMenu.getByRole('button')).toHaveText([
    'Message Maya',
    'View profile',
    'Remove from server…',
  ])
  const memberMenuBox = await memberMenu.boundingBox()
  const rosterBox = await page.locator('.member-list').boundingBox()
  if (!memberMenuBox || !rosterBox) throw new Error('The member menu or roster is missing.')
  expect(memberMenuBox.x + memberMenuBox.width).toBeLessThanOrEqual(rosterBox.x - 16)
  await both(page, 'member-menu')
  await memberMenu.getByRole('button', { name: 'View profile', exact: true }).click()
  const profile = page.getByRole('dialog', { name: 'Maya Lind', exact: true })
  await expect(profile).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(actions).toBeFocused()
  await actions.click()
  await page.route('**/api/direct/conversations', (route) => route.abort(), { times: 1 })
  await memberMenu.getByRole('button', { name: 'Message Maya Lind', exact: true }).click()
  await expect(memberMenu.getByRole('alert')).toBeVisible()
  await memberMenu.getByRole('button', { name: 'Message Maya Lind', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Conversation with Maya Lind', exact: true }),
  ).toBeVisible()
  await railTile(page, 'The studio').click()
  await expect(composer).toHaveValue('A little ✨ today')

  const settingsButton = page
    .locator('.account')
    .getByRole('button', { name: 'Settings', exact: true })
  await page.keyboard.press('Tab')
  await settingsButton.focus()
  await expect(page.getByRole('tooltip')).toHaveText('Settings')
  await both(page, 'settings-tooltip')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('tooltip')).not.toBeVisible()
  await settingsButton.click()
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await settings.getByRole('button', { name: 'Appearance', exact: true }).click()
  await settings.getByRole('button', { name: 'Create theme', exact: true }).click()
  const create = page.getByRole('dialog', { name: 'Create theme', exact: true })
  await create.getByRole('textbox', { name: 'Theme name', exact: true }).fill('Quiet custom')
  await create.getByRole('button', { name: 'Create theme', exact: true }).click()
  const themeButton = settings.getByRole('button', {
    name: 'More actions for Quiet custom',
    exact: true,
  })
  await themeButton.click()
  const themeMenu = page.getByRole('group', { name: 'Quiet custom actions', exact: true })
  await expect(themeMenu).toHaveCSS('width', '234px')
  await both(page, 'theme-menu')
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          sessionStorage.setItem('copied-theme', text)
        },
      },
    })
  })
  await themeMenu.getByRole('button', { name: 'Copy Quiet custom as JSON', exact: true }).click()
  await expect(themeMenu).toContainText('Copied')
  expect(
    JSON.parse((await page.evaluate(() => sessionStorage.getItem('copied-theme'))) ?? '{}').name,
  ).toBe('Quiet custom')
  await themeMenu.getByRole('button', { name: 'Edit Quiet custom', exact: true }).click()
  await page
    .getByRole('dialog', { name: 'Edit theme', exact: true })
    .getByRole('button', { name: 'Cancel', exact: true })
    .click()
  await expect(themeButton).toBeFocused()
  await themeButton.click()
  await themeMenu.getByRole('button', { name: 'Delete Quiet custom', exact: true }).click()
  await page
    .getByRole('dialog', { name: 'Delete Quiet custom?', exact: true })
    .getByRole('button', { name: 'Cancel', exact: true })
    .click()
  await page.keyboard.press('Escape')

  await page.setViewportSize({ width: 640, height: 480 })
  await emojiButton.click()
  await expect(picker).toBeInViewport({ ratio: 1 })
  await page.setViewportSize({ width: 800, height: 600 })
  await expect(picker).toBeInViewport({ ratio: 1 })
  await page.keyboard.press('Escape')
  await expect(composer).toHaveValue('A little ✨ today')

  const guestContext = await browser.newContext()
  try {
    const guest = await guestContext.newPage()
    await actAs(guest, 'maya')
    await guest.goto(browserApp)
    await guest.getByRole('button', { name: 'Huddle UI menu', exact: true }).click()
    await expect(guest.locator('#server-menu').getByRole('button')).toHaveText(['Settings'])
    await guest.keyboard.press('Escape')
    await railTile(guest, 'The studio').click()
    await guest.getByRole('button', { name: 'The studio menu', exact: true }).click()
    await expect(guest.locator('#server-menu').getByRole('button')).toHaveText(['Settings'])
    await guest.keyboard.press('Escape')
    await guest.getByRole('button', { name: 'Channel options', exact: true }).click()
    await expect(guest.locator('#channel-menu').getByRole('button')).toHaveText(['Settings'])
    await guest.keyboard.press('Escape')
    await guest.getByRole('button', { name: 'Member list', exact: true }).click()
    await guest.getByRole('button', { name: 'Actions for Adam Nilsson', exact: true }).click()
    await expect(
      guest.getByRole('group', { name: 'Adam Nilsson actions', exact: true }).getByRole('button'),
    ).toHaveText(['Message Adam', 'View profile'])
    await guest.keyboard.press('Escape')
    await guest.getByRole('button', { name: 'View Adam Nilsson', exact: true }).click()
    await expect(
      guest.getByRole('dialog', { name: 'Adam Nilsson', exact: true }).getByRole('button'),
    ).toHaveText(['', 'Message'])
  } finally {
    await guestContext.close()
  }
})
