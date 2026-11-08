import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { Channel, Room, ServerInvite, parseInvite } from '../packages/contracts/src/index'
import { Client } from '../apps/server/scripts/harness'
import { browserApp, expectHome, onboard, railTile, serverURL } from './accounts'
import { useScratchServer } from './server'

useScratchServer('ui')

async function both(page: Page, name: string) {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    const details = page.locator('.member-details:popover-open')
    if (await details.isVisible()) await details.getByRole('heading').click()
    else await page.getByRole('main').getByRole('heading', { level: 1 }).click()
    await page.mouse.move(0, 0)
    await page.evaluate(() => document.fonts.ready)
    const path = test.info().outputPath(`${name}-${colorScheme}.png`)
    await page.screenshot({ path, animations: 'disabled' })
    await test.info().attach(`${name}-${colorScheme}`, { path, contentType: 'image/png' })
  }
}

test('Members matches both themes and supports roster recovery, profile cards and direct messages', async ({
  page,
}) => {
  page.setDefaultTimeout(10000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await onboard(page, 'adam', 'Our place')
  const admin = new Client(serverURL, 'adam@huddle.test')
  await admin.stage()
  await admin.act({
    kind: 'profile.save',
    profile: { name: 'Adam Nilsson', avatar: { kind: 'mascot', shape: 'circle', color: 'teal' } },
  })
  await page.getByRole('button', { name: 'Members', exact: true }).click()
  const roster = page.getByRole('region', { name: /^Members/ })
  await expect(roster.getByRole('row')).toHaveCount(2)
  await expect(
    page.getByRole('heading', { name: 'You’re the first one here', exact: true }),
  ).toBeVisible()
  await page.setViewportSize({ width: 640, height: 480 })
  const heading = await page
    .getByRole('heading', { name: 'People on Our place', exact: true })
    .boundingBox()
  const title = await page.locator('.topbar strong').boundingBox()
  if (!heading || !title) throw new Error('The Members heading is not visible.')
  expect(heading.x).toBe(title.x)
  await page.setViewportSize({ width: 1440, height: 900 })
  await both(page, 'members-first')

  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/members', async (route) => {
    await gate
    await route.continue()
  })
  await page.reload()
  await page.getByRole('button', { name: 'Members', exact: true }).click()
  await expect(roster.getByRole('status')).toContainText('Loading people…')
  await both(page, 'members-loading')
  release()
  await expect(roster.getByRole('row')).toHaveCount(2)
  await page.unroute('**/api/members')

  const invite = ServerInvite.parse((await admin.call('/api/invite')).value)
  const code = parseInvite(invite.invite).code
  const names = [
    'Maya Lind',
    'Jonas Berg',
    'Leah Chen',
    'Nora West',
    'Elias Holm',
    'Sofia Park',
    'Ben Miller',
  ]
  const friends: Client[] = []
  for (const [index, name] of names.entries()) {
    const friend = new Client(serverURL, `friend${index}@huddle.test`)
    await friend.act({ kind: 'account.join', code, name })
    await friend.act({
      kind: 'profile.save',
      profile: {
        name,
        avatar: {
          kind: 'mascot',
          shape: index % 2 ? 'square' : 'circle',
          color: index % 2 ? 'sky' : 'indigo',
        },
      },
    })
    friends.push(friend)
  }
  const maya = friends[0]
  if (!maya) throw new Error('Maya is missing.')
  await page.reload()
  await page.getByRole('button', { name: 'Members', exact: true }).click()
  await expect(roster.getByRole('row')).toHaveCount(9)
  await expect(page.locator('.members')).toHaveCSS('width', '756px')
  await expect(
    page
      .getByRole('navigation', { name: 'Our place', exact: true })
      .getByRole('button', { name: 'Members', exact: true }),
  ).toHaveAttribute('aria-current', 'page')
  await expect(
    roster.getByRole('button', { name: 'Message Adam Nilsson', exact: true }),
  ).toHaveCount(0)
  await expect(page.getByRole('main')).not.toContainText('@huddle.test')
  await both(page, 'members-roster')

  await page.route('**/api/members', (route) => route.abort())
  await railTile(page, 'Home').click()
  await expect(page.locator('.member-list')).toHaveCount(0)
  await page.getByRole('button', { name: 'Members', exact: true }).click()
  await expect(roster.getByRole('alert')).toContainText('Couldn’t load friends')
  await both(page, 'members-failed')
  await page.unroute('**/api/members')
  await roster.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect(roster.getByRole('row')).toHaveCount(9)

  await page.route('**/api/direct/conversations', (route) => route.abort(), { times: 1 })
  await roster.getByRole('button', { name: 'Message Maya Lind', exact: true }).click()
  await expect(roster.getByRole('alert')).toBeVisible()
  await expect(roster.getByRole('row')).toHaveCount(9)
  await roster.getByRole('button', { name: 'Message Maya Lind', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Conversation with Maya Lind', exact: true }),
  ).toBeVisible()

  await page.getByRole('button', { name: 'Members', exact: true }).click()
  let finishTable = () => {}
  const tablePending = new Promise<void>((resolve) => {
    finishTable = resolve
  })
  await page.route(
    '**/api/direct/conversations',
    async (route) => {
      await tablePending
      await route.continue()
    },
    { times: 1 },
  )
  await roster.getByRole('button', { name: 'Message Jonas Berg', exact: true }).click()
  await expect(
    roster.getByRole('button', { name: 'Message Jonas Berg', exact: true }),
  ).toBeDisabled()
  const tableCancelled = page.waitForEvent('requestfailed', {
    predicate: (request) => new URL(request.url()).pathname === '/api/direct/conversations',
  })
  await railTile(page, 'Home').click()
  await tableCancelled
  finishTable()
  await expectHome(page)

  const room = Room.parse((await admin.call('/api/rooms', { name: 'The studio' })).value)
  const channel = Channel.parse(
    (await admin.call('/api/channels', { roomId: room.id, name: 'general', kind: 'text' })).value,
  )
  await admin.call('/api/messages', {
    retryId: randomUUID(),
    channelId: channel.id,
    body: 'A little space to keep in touch.',
  })
  await railTile(page, 'The studio').click()
  const composer = page.getByRole('textbox', { name: 'Message #general', exact: true })
  await composer.fill('Keep this draft while I look at a profile')
  await page.getByRole('button', { name: 'Member list', exact: true }).click()
  const panel = page.getByRole('complementary', { name: 'Server members', exact: true })
  await expect(panel).toHaveCSS('width', '256px')
  await expect(panel.getByRole('list', { name: 'Members', exact: true })).toContainText(
    'Admins · 1',
  )
  await expect(panel.getByRole('button', { name: 'View Adam Nilsson', exact: true })).toHaveCount(0)
  await both(page, 'members-beside-chat')
  const mayaRow = panel.getByRole('button', { name: 'View Maya Lind', exact: true })
  await mayaRow.focus()
  await page.keyboard.press('Enter')
  let details = page.getByRole('dialog', { name: 'Maya Lind', exact: true })
  await expect(details).toBeVisible()
  await expect(details).toHaveCSS('width', '320px')
  await expect(details.getByRole('img', { name: 'indigo circle mascot', exact: true })).toHaveCSS(
    'width',
    '56px',
  )
  await expect(
    details.getByRole('button', { name: 'Close member details', exact: true }),
  ).toBeFocused()
  await expect(details).toContainText('Joined Our place on')
  await both(page, 'members-details')

  const row = page
    .getByRole('navigation', { name: 'The studio channels', exact: true })
    .getByRole('button', { name: /^general/ })
  let reads = 0
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/read') reads += 1
  })
  const before = reads
  await maya.call('/api/messages', {
    retryId: randomUUID(),
    channelId: channel.id,
    body: 'Sent while the profile is open',
  })
  await expect(
    page.getByRole('main').getByText('Sent while the profile is open', { exact: true }),
  ).toBeAttached()
  await expect(row).toHaveAccessibleName('general unread')
  await page.waitForTimeout(600)
  expect(reads).toBe(before)
  await page.keyboard.press('Escape')
  await expect(details).toHaveCount(0)
  await expect(mayaRow).toBeFocused()
  await expect(row).toHaveAccessibleName('general')
  await expect(composer).toHaveValue('Keep this draft while I look at a profile')

  await mayaRow.click()
  await page.route('**/api/direct/conversations', (route) => route.abort(), { times: 1 })
  await details.getByRole('button', { name: 'Message Maya Lind', exact: true }).click()
  await expect(details.getByRole('alert')).toBeVisible()
  await both(page, 'members-message-failed')
  await panel.getByRole('button', { name: 'View Jonas Berg', exact: true }).click()
  const jonasDetails = page.getByRole('dialog', { name: 'Jonas Berg', exact: true })
  await expect(jonasDetails).toBeVisible()
  await expect(jonasDetails.getByRole('alert')).toHaveCount(0)
  await expect(
    jonasDetails.getByRole('button', { name: 'Message Jonas Berg', exact: true }),
  ).toBeEnabled()
  await page.keyboard.press('Escape')
  await expect(panel.getByRole('button', { name: 'View Jonas Berg', exact: true })).toBeFocused()
  await mayaRow.click()
  await details.getByRole('button', { name: 'Message Maya Lind', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Conversation with Maya Lind', exact: true }),
  ).toBeVisible()
  await railTile(page, 'The studio').click()
  await expect(composer).toHaveValue('Keep this draft while I look at a profile')

  await mayaRow.click()
  let finish = () => {}
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  await page.route(
    '**/api/direct/conversations',
    async (route) => {
      await pending
      await route.continue()
    },
    { times: 1 },
  )
  await details.getByRole('button', { name: 'Message Maya Lind', exact: true }).click()
  await expect(
    details.getByRole('button', { name: 'Message Maya Lind', exact: true }),
  ).toBeDisabled()
  const cancelled = page.waitForEvent('requestfailed', {
    predicate: (request) => new URL(request.url()).pathname === '/api/direct/conversations',
  })
  await details.getByRole('button', { name: 'Close member details', exact: true }).click()
  await cancelled
  finish()
  await expect(
    page.getByRole('heading', { name: 'Welcome to #general', exact: true }),
  ).toBeVisible()
  await expect(composer).toHaveValue('Keep this draft while I look at a profile')

  await maya.act({
    kind: 'profile.save',
    profile: { name: 'Maya Lindén', avatar: { kind: 'mascot', shape: 'bean', color: 'violet' } },
  })
  await mayaRow.click()
  details = page.getByRole('dialog', { name: 'Maya Lindén', exact: true })
  await expect(details).toBeVisible()
  await expect(details.getByRole('img', { name: 'violet bean mascot' })).toBeVisible()
  await page.mouse.click(800, 700)
  await expect(details).toHaveCount(0)
  await panel.getByRole('button', { name: 'View Maya Lindén', exact: true }).click()
  await expect(details).toBeVisible()
  await panel.getByRole('button', { name: 'Close member list', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(details).toHaveCount(0)
  await expect(panel).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Member list', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  )
  await expect(composer).toHaveValue('Keep this draft while I look at a profile')
})
