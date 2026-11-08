import { expect, test, type Locator, type Page } from '@playwright/test'
import { parseInvite } from '../packages/contracts/src/index'
import { actAs, browserApp, member, railTile, serverURL } from './accounts'
import { useScratchServer } from './server'

const server = useScratchServer('api', { LIVEKIT_API_SECRET: '' })

async function both(page: Page, name: string, preview?: Locator) {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    if (preview) {
      await preview
        .getByRole('radio', { name: colorScheme === 'light' ? 'Light' : 'Dark', exact: true })
        .check()
      await expect(preview.getByRole('textbox', { name: 'Background', exact: true })).toHaveValue(
        colorScheme === 'light' ? '#fcfcfc' : '#161616',
      )
      await expect(preview.getByRole('textbox', { name: 'Accent', exact: true })).toHaveValue(
        colorScheme === 'light' ? '#242424' : '#eaeaea',
      )
    }
    const heading = page.locator('dialog[open]').last().getByRole('heading').first()
    if (await heading.isVisible()) await heading.click()
    await page.mouse.move(0, 0)
    await page.evaluate(() => document.fonts.ready)
    const path = test.info().outputPath(`${name}-${colorScheme}.png`)
    await page.screenshot({ path, animations: 'disabled' })
    await test.info().attach(`${name}-${colorScheme}`, { path, contentType: 'image/png' })
  }
}

test('quiet dialogs and states retain drafts, recover and work in both themes', async ({
  page,
  browser,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await actAs(page, 'uiadmin')
  await page.addInitScript(() => {
    const sockets: WebSocket[] = []
    const NativeSocket = window.WebSocket
    window.WebSocket = class extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        sockets.push(this)
      }
    }
    Object.assign(window, { dialogTestSockets: sockets })
  })
  await page.goto(browserApp)
  await expect(page.locator('.account').getByRole('status')).toHaveText('Connected')

  await railTile(page, 'Create room').click()
  let dialog = page.getByRole('dialog', { name: 'Create a room', exact: true })
  await dialog.getByLabel('Room name').fill('Book club')
  await expect(dialog).toHaveCSS('width', '504px')
  await both(page, 'dialog-create-room')
  let releaseRoom = () => {}
  const roomGate = new Promise<void>((resolve) => {
    releaseRoom = resolve
  })
  await page.route(
    '**/api/rooms',
    async (route) => {
      await roomGate
      await route.continue()
    },
    { times: 1 },
  )
  await dialog.getByRole('button', { name: 'Create room', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Creating your room…' })).toBeDisabled()
  await both(page, 'state-creating-room')
  releaseRoom()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Book club has no channels yet' })).toBeVisible()
  await both(page, 'state-empty-room')
  await page.getByRole('main').getByRole('button', { name: 'Share invite', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Share invite', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Create a channel', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Add a channel', exact: true })
  const voice = dialog.getByRole('radio', { name: 'Voice', exact: true })
  await voice.check()
  await expect(voice).toBeChecked()
  await voice.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(dialog.getByRole('radio', { name: 'Text', exact: true })).toBeChecked()
  await dialog.getByLabel('Channel name').fill('reading-list')
  await both(page, 'dialog-add-channel')
  await dialog.getByRole('button', { name: 'Create channel', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Welcome to #reading-list' })).toBeVisible()
  await both(page, 'state-empty-channel')
  const composer = page.getByRole('textbox', { name: 'Message #reading-list', exact: true })
  await composer.fill('Keep this draft while a dialog is open')
  await page.getByRole('button', { name: 'Create text channel', exact: true }).click()
  await dialog.getByLabel('Channel name').fill('reading-list')
  await dialog.getByRole('button', { name: 'Create channel', exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveText('That name is already in use.')
  await expect(dialog.getByLabel('Channel name')).toHaveValue('reading-list')
  await both(page, 'state-channel-name-taken')
  await page.keyboard.press('Escape')
  await expect(composer).toHaveValue('Keep this draft while a dialog is open')

  let releaseInvite = () => {}
  const inviteGate = new Promise<void>((resolve) => {
    releaseInvite = resolve
  })
  await page.route(
    '**/api/invite',
    async (route) => {
      await inviteGate
      await route.continue()
    },
    { times: 1 },
  )
  await page.getByRole('button', { name: 'Share invite', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Share invite', exact: true })
  await expect(dialog.getByRole('status')).toContainText('Loading invite…')
  await both(page, 'state-invite-loading')
  releaseInvite()
  await expect(dialog.getByRole('button', { name: 'Copy invite', exact: true })).toBeVisible()
  await both(page, 'dialog-share-invite')
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          sessionStorage.setItem('copied-invite', value)
        },
      },
    })
  })
  await dialog.getByRole('button', { name: 'Copy invite', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Copied', exact: true })).toBeVisible()
  const copied = await page.evaluate(() => sessionStorage.getItem('copied-invite'))
  if (!copied) throw new Error('The invite was not copied.')
  expect(parseInvite(copied).origin).toBe(serverURL)
  await expect(dialog).not.toContainText('#join=')
  await both(page, 'state-invite-copied')
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(composer).toHaveValue('Keep this draft while a dialog is open')

  const friendContext = await browser.newContext()
  try {
    const friend = await friendContext.newPage()
    await member(server.admin, friend, 'Maya', browserApp)
    await railTile(page, 'Home').click()
    await page.getByRole('button', { name: 'New message', exact: true }).first().click()
    await page
      .getByRole('dialog', { name: 'New message', exact: true })
      .getByRole('option', { name: 'Maya', exact: true })
      .click()
    await expect(page.locator('.empty-conversation')).toBeVisible()
    await both(page, 'state-empty-direct')
    await page.route('**/api/messages?*', (route) => route.abort(), { times: 1 })
    await railTile(page, 'Book club').click()
    await expect(page.getByRole('alert')).toContainText('Couldn’t load messages')
    await expect(composer).toHaveValue('Keep this draft while a dialog is open')
    await both(page, 'state-history-failed')
    await page.getByRole('button', { name: 'Try again', exact: true }).click()
    await expect(page.getByText('Couldn’t load messages', { exact: true })).toHaveCount(0)
    await expect(composer).toHaveValue('Keep this draft while a dialog is open')
    await page.route('**/api/messages', (route) => route.abort(), { times: 1 })
    await composer.fill('A message worth keeping')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect(page.locator('.message-retry')).toContainText('Couldn’t send this message.')
    await both(page, 'state-message-retry')
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(page.locator('.message-retry')).toHaveCount(0)
    await expect(page.getByText('A message worth keeping', { exact: true })).toHaveCount(1)
    await composer.fill('Keep this draft through reconnecting')
    await page.context().setOffline(true)
    await page.evaluate(() => {
      const { dialogTestSockets } = window as unknown as { dialogTestSockets: WebSocket[] }
      for (const socket of dialogTestSockets) socket.close()
    })
    await expect(page.locator('.thread-state')).toContainText('Reconnecting…')
    await both(page, 'state-reconnecting')
    await page.context().setOffline(false)
    await expect(page.locator('.account').getByRole('status')).toHaveText('Connected')
    await expect(page.getByText('Reconnecting…', { exact: true })).toHaveCount(0)
    await expect(composer).toHaveValue('Keep this draft through reconnecting')
  } finally {
    await friendContext.close()
  }

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await settings.getByRole('button', { name: 'Appearance', exact: true }).click()
  await settings.getByRole('button', { name: 'Create theme', exact: true }).click()
  const panel = page.getByRole('dialog', { name: 'Create theme', exact: true })
  await panel.getByLabel('Theme name').fill('Aurora')
  await expect(panel).toHaveCSS('width', '568px')
  await both(page, 'dialog-create-theme', panel)
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(settings.getByRole('button', { name: 'Create theme', exact: true })).toBeFocused()
  await settings.getByRole('button', { name: 'Add theme', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Add a theme', exact: true })
  await expect(dialog).toHaveCSS('width', '632px')
  await both(page, 'dialog-add-theme')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.keyboard.press('Escape')
})
