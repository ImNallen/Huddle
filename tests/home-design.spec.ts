import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import {
  Channel,
  DirectConversation,
  DirectMessage,
  Message,
  Room,
  ServerInvite,
  parseInvite,
} from '../packages/contracts/src/index'
import { Client, runningLivekit } from '../apps/server/scripts/harness'
import { actAs, browserApp, expectHome, railTile, serverURL } from './accounts'
import { useScratchServer } from './server'
import {
  channelRow,
  expectInCall,
  fakeMicrophoneLaunch,
  join as joinVoice,
  panel,
  watchCalls,
} from './voice'

const server = useScratchServer('api')
test.beforeAll(() => runningLivekit())
test.use({ launchOptions: fakeMicrophoneLaunch })

test('Home shows live conversations, room activity, and people in voice in both themes', async ({
  browser,
  page,
}) => {
  const admin = server.admin
  await admin.act({
    kind: 'profile.save',
    profile: { name: 'Adam Nilsson', avatar: { kind: 'mascot', shape: 'circle', color: 'teal' } },
  })
  const studio = Room.parse((await admin.call('/api/rooms', { name: 'The studio' })).value)
  const coffee = Room.parse((await admin.call('/api/rooms', { name: 'Coffee club' })).value)
  const books = Room.parse((await admin.call('/api/rooms', { name: 'Book club' })).value)
  const channel = async (room: Room, name: string, kind: 'text' | 'voice' = 'text') =>
    Channel.parse((await admin.call('/api/channels', { roomId: room.id, name, kind })).value)
  const general = await channel(studio, 'general')
  const lounge = await channel(studio, 'lounge', 'voice')
  await channel(coffee, 'coffee')
  const reading = await channel(books, 'reading')
  const code = parseInvite(ServerInvite.parse((await admin.call('/api/invite')).value).invite).code
  const people = []
  for (const [login, name, color] of [
    ['maya', 'Maya Lind', 'rose'],
    ['jonas', 'Jonas Berg', 'indigo'],
    ['leah', 'Leah Chen', 'sky'],
  ] as const) {
    const client = new Client(serverURL, `${login}@huddle.test`)
    await client.act({ kind: 'account.join', code, name })
    await client.act({
      kind: 'profile.save',
      profile: { name, avatar: { kind: 'mascot', shape: 'circle', color } },
    })
    people.push(client)
  }
  const [maya, jonas, leah] = people
  if (!maya || !jonas || !leah || !admin.userId) throw new Error('Home needs its four members.')
  const post = async (client: Client, channel: Channel, body: string) =>
    Message.parse(
      (await client.call('/api/messages', { retryId: randomUUID(), channelId: channel.id, body }))
        .value,
    )
  await post(maya, general, 'Taking the slow route today.')
  await post(jonas, general, 'Anyone up for co-working?')
  await post(leah, reading, 'A new book for the weekend.')
  const direct = async (client: Client, bodies: string[]) => {
    const conversation = DirectConversation.parse(
      (await client.call('/api/direct/conversations', { userId: admin.userId })).value,
    )
    for (const body of bodies) {
      DirectMessage.parse(
        (
          await client.call('/api/direct/messages', {
            retryId: randomUUID(),
            conversationId: conversation.id,
            body,
          })
        ).value,
      )
    }
    return conversation
  }
  const leahDirect = await direct(leah, ['See you in the lounge later.'])
  const reply = DirectMessage.parse(
    (
      await admin.call('/api/direct/messages', {
        retryId: randomUUID(),
        conversationId: leahDirect.id,
        body: 'See you in the lounge later.',
      })
    ).value,
  )
  await admin.call('/api/direct/read', { conversationId: leahDirect.id, cursor: reply.cursor })
  await direct(jonas, ['Found the perfect spot for Saturday.'])
  await direct(maya, ['Morning!', 'Are you around for a little co-working?'])

  const mayaContext = await browser.newContext()
  const jonasContext = await browser.newContext()
  try {
    const callers = await Promise.all([mayaContext.newPage(), jonasContext.newPage()])
    for (const [index, caller] of callers.entries()) {
      await actAs(caller, index === 0 ? 'maya' : 'jonas')
      await caller.goto(browserApp)
      await expectHome(caller)
      await railTile(caller, studio.name).click()
      await channelRow(caller, studio.name, lounge.name).click()
      await joinVoice(caller).click()
      await expectInCall(caller)
    }

    await watchCalls(page.context())
    await actAs(page, 'uiadmin')
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(browserApp)
    await expectHome(page)
    const main = page.getByRole('main')
    const rooms = main.getByRole('region', { name: 'Your rooms', exact: true })
    const conversations = main.getByRole('region', { name: 'Direct messages', exact: true })
    const voice = main.getByRole('region', { name: 'People in voice', exact: true })
    await expect(conversations.getByRole('listitem')).toHaveCount(3)
    await expect(conversations.getByRole('button', { name: /^Maya Lind/ })).toContainText('2 new')
    await expect(conversations.getByRole('button', { name: /^Jonas Berg/ })).toContainText('1 new')
    await expect(conversations.getByRole('button', { name: /^Leah Chen/ })).toContainText(
      'You: See you in the lounge later.',
    )
    await expect(rooms.getByRole('listitem')).toHaveCount(3)
    await expect(rooms.getByRole('button', { name: /^The studio/ })).toContainText(
      '2 new in #general',
    )
    await expect(rooms.getByRole('button', { name: /^Book club/ })).toContainText(
      '1 new in #reading',
    )
    await expect(rooms.getByRole('button', { name: /^Coffee club/ })).toContainText(
      'A place to catch up',
    )
    await expect(voice).toContainText('Maya Lind and Jonas Berg are in lounge · The studio')
    await expect(page.getByRole('button', { name: 'Share invite', exact: true })).toHaveCount(1)
    const sidebar = page.getByRole('navigation', { name: 'Huddle UI', exact: true })
    await expect(sidebar.getByRole('button', { name: 'Home', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await expect(sidebar.getByRole('button', { name: /^Maya Lind/ })).toContainText('2')
    await expect(sidebar.locator('.huddle-logo')).toHaveJSProperty('offsetWidth', 24)
    await expect(sidebar.locator('.huddle-logo')).toHaveJSProperty('offsetHeight', 24)

    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
      await page.evaluate(() => document.fonts.ready)
      await expect(main).toHaveCSS(
        'background-color',
        colorScheme === 'light' ? 'rgb(252, 252, 252)' : 'rgb(22, 22, 22)',
      )
      const path = test.info().outputPath(`home-${colorScheme}.png`)
      await page.screenshot({ path })
      await test.info().attach(`home-${colorScheme}`, { path, contentType: 'image/png' })
    }

    await voice.getByRole('button', { name: 'Open lounge', exact: true }).click()
    await expect(main.getByRole('heading', { name: 'lounge', exact: true })).toBeVisible()
    expect(await page.evaluate(() => window.probe.microphones.length)).toBe(0)
    await railTile(page, 'Home').click()
    await conversations.getByRole('button', { name: /^Maya Lind/ }).click()
    await expect(
      page.getByRole('textbox', { name: 'Message @Maya Lind', exact: true }),
    ).toBeVisible()
    await sidebar.getByRole('button', { name: 'Home', exact: true }).click()
    await expect(
      conversations.getByRole('button', { name: /^Maya Lind/ }).locator('.feed-unread'),
    ).toHaveCount(0)
    await expect(
      sidebar.getByRole('button', { name: /^Maya Lind/ }).locator('.direct-count'),
    ).toHaveCount(0)
    await rooms.getByRole('button', { name: /^Book club/ }).click()
    await expect(
      main.getByRole('heading', { name: 'Welcome to #reading', exact: true }),
    ).toBeVisible()
    await railTile(page, 'Home').click()
    await expect(rooms.getByRole('button', { name: /^Book club/ })).toContainText(
      'A place to catch up',
    )

    await main.getByRole('button', { name: 'New message', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'New message', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.setViewportSize({ width: 640, height: 480 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(640)
    await expect(voice.getByRole('button', { name: 'Open lounge', exact: true })).toBeVisible()
    for (const caller of callers)
      await panel(caller).getByRole('button', { name: 'Leave call', exact: true }).click()
    await expect(voice).toHaveCount(0)
  } finally {
    await mayaContext.close()
    await jonasContext.close()
  }
})
