import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import {
  Channel,
  Room,
  ServerInfo,
  ServerInvite,
  parseInvite,
} from '../packages/contracts/src/index'
import {
  actAs,
  browserApp,
  expectHome,
  loginOf,
  member,
  railTile,
  serverURL,
  skipProfile,
} from './accounts'
import { useScratchServer } from './server'

const server = useScratchServer('api')
const outbox = (page: Page) =>
  page.evaluate(() =>
    Object.keys(localStorage)
      .filter((key) => key.startsWith('huddle.outbox:'))
      .flatMap((key) =>
        (JSON.parse(localStorage.getItem(key) ?? '[]') as { body: string }[]).map(
          (entry) => entry.body,
        ),
      ),
  )
const channels = (page: Page, roomName: string) =>
  page.getByRole('navigation', { name: `${roomName} channels`, exact: true })
const notice = (page: Page) => page.locator('.app-notice')
async function openAdmin(page: Page) {
  await actAs(page, 'uiadmin')
  await page.goto(browserApp)
  await expect(page.locator('.account').getByRole('status')).toHaveText('Connected')
}

test('renames reach a friend live, and deletions move them on and leave no trace', async ({
  page,
  browser,
}) => {
  const room = Room.parse((await server.admin.call('/api/rooms', { name: 'Studio' })).value)
  await server.admin.call('/api/channels', { roomId: room.id, name: 'general', kind: 'text' })
  const plans = Channel.parse(
    (await server.admin.call('/api/channels', { roomId: room.id, name: 'plans', kind: 'text' }))
      .value,
  )
  const friendContext = await browser.newContext()
  try {
    const friend = await friendContext.newPage()
    await member(server.admin, friend, 'Maya', '/')
    await openAdmin(page)

    await page.getByRole('button', { name: 'Huddle UI menu', exact: true }).click()
    await page.getByRole('button', { name: 'Rename server…', exact: true }).click()
    let dialog = page.getByRole('dialog', { name: 'Rename server', exact: true })
    await expect(dialog.getByLabel('Server name')).toHaveValue('Huddle UI')
    await dialog.getByLabel('Server name').fill('Harbor')
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(friend.getByRole('button', { name: 'Harbor menu', exact: true })).toBeVisible()
    await expect
      .poll(() =>
        friend.evaluate(
          () =>
            (JSON.parse(localStorage.getItem('huddle.servers') ?? '[]') as { name: string }[])[0]
              ?.name,
        ),
      )
      .toBe('Harbor')

    await railTile(page, 'Studio').click()
    await railTile(friend, 'Studio').click()
    await expect(friend.getByRole('heading', { name: 'Welcome to #general' })).toBeVisible()
    await page.getByRole('button', { name: 'Studio menu', exact: true }).click()
    await page.getByRole('button', { name: 'Rename room…', exact: true }).click()
    dialog = page.getByRole('dialog', { name: 'Rename room', exact: true })
    await dialog.getByLabel('Room name').fill('Workshop')
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(railTile(friend, 'Workshop')).toBeVisible()
    await expect(railTile(friend, 'Studio')).toHaveCount(0)

    await page.getByRole('button', { name: 'Channel options', exact: true }).click()
    await page.getByRole('button', { name: 'Rename channel…', exact: true }).click()
    dialog = page.getByRole('dialog', { name: 'Rename channel', exact: true })
    await dialog.getByLabel('Channel name').fill('Lobby')
    await expect(dialog.getByLabel('Channel name')).toHaveValue('lobby')
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(friend.getByRole('heading', { name: 'Welcome to #lobby' })).toBeVisible()
    await expect(channels(friend, 'Workshop').getByRole('button')).toHaveText(['lobby', 'plans'])

    await channels(friend, 'Workshop').getByRole('button', { name: 'plans' }).click()
    const composer = friend.getByRole('textbox', { name: 'Message #plans', exact: true })
    await friend.route('**/api/messages', (route) => route.abort(), { times: 1 })
    await composer.fill('Bring snacks')
    await friend.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect(friend.locator('.message-retry')).toContainText('Couldn’t send this message.')
    expect(await outbox(friend)).toEqual(['Bring snacks'])
    await composer.fill('A draft for plans')
    await friend.locator('.account').getByRole('button', { name: 'Settings' }).click()
    await expect(friend.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible()
    await server.admin.call('/api/messages', {
      channelId: plans.id,
      retryId: randomUUID(),
      body: '@Maya can you check these?',
    })
    const badge = friend.locator('.rail-tile[aria-label="Workshop"] .rail-count')
    await expect(badge).toHaveText('1')

    await channels(page, 'Workshop').getByRole('button', { name: 'plans' }).click()
    await page.getByRole('button', { name: 'Channel options', exact: true }).click()
    await page.getByRole('button', { name: 'Delete channel…', exact: true }).click()
    dialog = page.getByRole('dialog', { name: 'Delete #plans?', exact: true })
    await expect(dialog).toContainText('every message, unread count, and mention in it')
    const remove = dialog.getByRole('button', { name: 'Delete channel', exact: true })
    await expect(remove).toBeDisabled()
    await dialog.getByLabel('Type plans to confirm').fill('Plans')
    await expect(remove).toBeDisabled()
    await dialog.getByLabel('Type plans to confirm').fill('plans')
    await remove.click()
    await expect(dialog).toHaveCount(0)
    await expect(notice(page)).toHaveText('#plans was deleted.')
    await expect(page.getByRole('heading', { name: 'Welcome to #lobby' })).toBeVisible()

    await expect(badge).toHaveCount(0)
    expect(await outbox(friend)).toEqual([])
    await friend.keyboard.press('Escape')
    await expect(friend.getByRole('heading', { name: 'Welcome to #lobby' })).toBeVisible()
    await expect(notice(friend)).toHaveText('#plans was deleted.')
    await expect(friend.getByRole('textbox', { name: 'Message #lobby', exact: true })).toHaveValue(
      '',
    )
    await expect(channels(friend, 'Workshop').getByRole('button')).toHaveText(['lobby'])
    await expect(friend.getByRole('main')).not.toContainText('Bring snacks')
    await expect(friend.getByRole('main')).not.toContainText('can you check these')
    await friend.reload()
    await expectHome(friend)
    expect(await outbox(friend)).toEqual([])
    await railTile(friend, 'Workshop').click()
    await expect(friend.getByRole('heading', { name: 'Welcome to #lobby' })).toBeVisible()
    await expect(friend.locator('.message-retry')).toHaveCount(0)

    await page.getByRole('button', { name: 'Workshop menu', exact: true }).click()
    await page.getByRole('button', { name: 'Delete room…', exact: true }).click()
    dialog = page.getByRole('dialog', { name: 'Delete Workshop?', exact: true })
    await expect(dialog).toContainText('This permanently deletes Workshop and its channel')
    await dialog.getByLabel('Type Workshop to confirm').fill('Workshop')
    await dialog.getByRole('button', { name: 'Delete room', exact: true }).click()
    await expect(notice(page)).toHaveText('Workshop was deleted.')
    await expectHome(page)
    await expectHome(friend)
    await expect(notice(friend)).toHaveText('Workshop was deleted.')
    await expect(railTile(friend, 'Workshop')).toHaveCount(0)
    await notice(friend).getByRole('button', { name: 'Dismiss', exact: true }).click()
    await expect(notice(friend)).toHaveCount(0)
  } finally {
    await friendContext.close()
  }
})

test('a slow create response loses to a rename or delete that the socket delivered first', async ({
  page,
}) => {
  const room = Room.parse((await server.admin.call('/api/rooms', { name: 'Garage' })).value)
  const general = Channel.parse(
    (await server.admin.call('/api/channels', { roomId: room.id, name: 'general', kind: 'text' }))
      .value,
  )
  await openAdmin(page)
  await railTile(page, 'Garage').click()
  const nav = channels(page, 'Garage')
  const named = nav.getByRole('button').filter({ hasText: /\S/ })
  await expect(named).toHaveText(['general'])

  const later = async (
    name: string,
    change: (channel: Channel) => Promise<unknown>,
    settled: string[],
  ) => {
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let created = (_: Channel) => {}
    const createdChannel = new Promise<Channel>((resolve) => {
      created = resolve
    })
    await page.route(
      '**/api/channels',
      async (route) => {
        const response = await route.fetch()
        created(Channel.parse(await response.json()))
        await held
        await route.fulfill({ response })
      },
      { times: 1 },
    )
    await page.getByRole('button', { name: 'Create text channel', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Add a channel', exact: true })
    await dialog.getByLabel('Channel name').fill(name)
    await dialog.getByRole('button', { name: 'Create channel', exact: true }).click()
    await change(await createdChannel)
    await expect(named).toHaveText(settled)
    release()
    await expect(dialog).toHaveCount(0)
    await expect(named).toHaveText(settled)
  }

  await later(
    'bench',
    (channel) =>
      server.admin.call('/api/channels/rename', {
        channelId: channel.id,
        kind: 'text',
        name: 'tools',
      }),
    ['general', 'tools'],
  )
  await expect(page.getByRole('heading', { name: 'Welcome to #tools' })).toBeVisible()

  await later(
    'scrap',
    async (channel) => {
      await server.admin.call('/api/channels/delete', { channelId: channel.id, confirm: 'scrap' })
      await server.admin.call('/api/channels/rename', {
        channelId: general.id,
        kind: 'text',
        name: 'main',
      })
    },
    ['main', 'tools'],
  )
  await page.reload()
  await railTile(page, 'Garage').click()
  await expect(named).toHaveText(['main', 'tools'])
})

test('a removed friend sees why, stays out, and comes back with their history once unblocked', async ({
  page,
  browser,
}) => {
  const room = Room.parse((await server.admin.call('/api/rooms', { name: 'Porch' })).value)
  await server.admin.call('/api/channels', { roomId: room.id, name: 'chat', kind: 'text' })
  const { name: serverName } = ServerInfo.parse((await server.admin.call('/api/info')).value)
  const code = parseInvite(
    ServerInvite.parse((await server.admin.call('/api/invite')).value).invite,
  ).code
  const friendContext = await browser.newContext()
  try {
    const friend = await friendContext.newPage()
    await member(server.admin, friend, 'Noor', browserApp)
    await railTile(friend, 'Porch').click()
    await friend.getByRole('textbox', { name: 'Message #chat', exact: true }).fill('Noor was here')
    await friend.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect(friend.getByText('Noor was here', { exact: true })).toBeVisible()

    await openAdmin(page)
    await page.getByRole('button', { name: 'Members', exact: true }).click()
    const roster = page.getByRole('region', { name: /^Members/ })
    await roster.getByRole('button', { name: 'Message Noor', exact: true }).click()
    await page.getByRole('textbox', { name: 'Message @Noor', exact: true }).fill('Hi Noor')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect(page.getByText('Hi Noor', { exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'Members', exact: true }).click()
    await expect(
      roster.getByRole('button', { name: 'More actions for uiadmin', exact: true }),
    ).toHaveCount(0)
    await roster.getByRole('button', { name: 'More actions for Noor', exact: true }).click()
    await page.getByRole('button', { name: 'Remove from server…', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Remove Noor?', exact: true })
    await expect(dialog).toContainText(
      'They leave every room, call, and group, and their Tailscale login can’t rejoin until you unblock them. Their messages stay, under their name.',
    )
    await dialog.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(dialog).toHaveCount(0)

    const removed = friend.getByRole('heading', { name: `You were removed from ${serverName}` })
    await expect(removed).toBeVisible({ timeout: 5000 })
    await expect(friend.getByText(loginOf('Noor'), { exact: true })).toBeVisible()
    await friend.evaluate(
      ({ origin, code }) => localStorage.setItem(`huddle.join-code:${origin}`, code),
      { origin: serverURL, code },
    )
    await friend.reload()
    await expect(removed).toBeVisible()
    await expect(friend.getByRole('button', { name: 'Create account', exact: true })).toHaveCount(0)

    const noorRow = roster.getByRole('row').filter({ hasText: 'Noor' })
    await expect(noorRow).toHaveCount(0)
    const blocked = page.getByRole('region', { name: 'Blocked · 1', exact: true })
    await expect(blocked.getByRole('row').nth(1)).toContainText('Noor')
    await page
      .getByRole('navigation', { name: serverName, exact: true })
      .getByRole('button', { name: 'Noor', exact: true })
      .click()
    await expect(page.getByText('Hi Noor', { exact: true })).toBeVisible()
    await expect(
      page.getByRole('status').filter({ hasText: 'no longer on this server' }),
    ).toHaveText('Noor is no longer on this server. You can still read your conversation.')
    await expect(page.getByRole('textbox', { name: 'Message @Noor', exact: true })).toHaveCount(0)
    await railTile(page, 'Porch').click()
    await expect(page.getByRole('article').filter({ hasText: 'Noor was here' })).toContainText(
      'Noor',
    )

    await railTile(page, 'Home').click()
    await page.getByRole('button', { name: 'Members', exact: true }).click()
    await blocked.getByRole('button', { name: 'Unblock Noor', exact: true }).click()
    const unblocked = page.getByRole('region', { name: 'Blocked · 0', exact: true })
    await expect(unblocked.getByRole('status')).toHaveText('Noor can rejoin with your invite.')
    await expect(unblocked).toContainText('Nobody is blocked')

    await friend.getByRole('button', { name: 'Check again', exact: true }).click()
    await expect(friend.getByRole('heading', { name: `Join ${serverName}` })).toBeVisible()
    await friend.getByRole('button', { name: 'Create account', exact: true }).click()
    await skipProfile(friend)
    await expectHome(friend)
    await railTile(friend, 'Porch').click()
    await expect(friend.getByText('Noor was here', { exact: true })).toBeVisible()
    await page
      .getByRole('navigation', { name: serverName, exact: true })
      .getByRole('button', { name: 'Noor', exact: true })
      .click()
    await expect(page.getByRole('textbox', { name: 'Message @Noor', exact: true })).toBeVisible()
  } finally {
    await friendContext.close()
  }
})
