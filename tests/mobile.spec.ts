import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test'
import {
  Channel,
  DirectConversation,
  DirectMessage,
  GroupObservation,
  Message,
  Room,
  ServerInvite,
  parseInvite,
} from '../packages/contracts/src/index'
import { Client, runningLivekit } from '../apps/server/scripts/harness'
import { actAs, browserApp, expectHome, rail, railTile, serverURL } from './accounts'
import { stubKlipy } from './gifs'
import { useScratchServer } from './server'
import {
  channelRow,
  expectInCall,
  fakeMicrophoneLaunch,
  join as joinVoice,
  profileBar,
} from './voice'

const server = useScratchServer('api')
const phone = { width: 390, height: 844 }
test.use({
  launchOptions: fakeMicrophoneLaunch,
  viewport: phone,
  hasTouch: true,
  isMobile: true,
  contextOptions: { reducedMotion: 'reduce' },
})
const shots = process.env.HUDDLE_MOBILE_SHOTS

async function capture(page: Page, name: string) {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await page.evaluate(() => document.fonts.ready)
    const path = test.info().outputPath(`${name}-${colorScheme}.png`)
    await page.screenshot({ path, animations: 'disabled' })
    await test.info().attach(`${name}-${colorScheme}`, { path, contentType: 'image/png' })
    if (shots) {
      mkdirSync(shots, { recursive: true })
      copyFileSync(path, join(shots, `${name}-${colorScheme}.png`))
    }
  }
  await page.emulateMedia({ colorScheme: 'light' })
}
async function expectNoSideScroll(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
    'the page never scrolls sideways',
  ).toBe(page.viewportSize()?.width)
}
/** Real touches through Chrome's input pipeline, so the page sees touch pointer events. */
async function finger(page: Page) {
  const cdp = await page.context().newCDPSession(page)
  const send = (
    type: 'touchStart' | 'touchMove' | 'touchEnd',
    points: { x: number; y: number }[],
  ) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points })
  return {
    async longPress(target: Locator) {
      const box = await target.boundingBox()
      if (!box) throw new Error('Nothing to press.')
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      await send('touchStart', [point])
      await page.waitForTimeout(700)
      await send('touchEnd', [])
    },
    /** Drags slowly, so the release decides by distance and never as a flick. */
    async drag(from: { x: number; y: number }, toX: number, during?: () => Promise<void>) {
      await send('touchStart', [from])
      const steps = Math.ceil((toX - from.x) / 8)
      for (let step = 1; step <= steps; step++) {
        await send('touchMove', [{ x: from.x + ((toX - from.x) * step) / steps, y: from.y }])
        await page.waitForTimeout(32)
      }
      await during?.()
      await send('touchEnd', [])
    },
  }
}

const main = (page: Page) => page.getByRole('main')
const channels = (page: Page) =>
  page.getByRole('navigation', { name: 'The studio channels', exact: true })
const composer = (page: Page, name: string) =>
  page.getByRole('textbox', { name: `Message ${name}`, exact: true })
const back = (page: Page) => main(page).getByRole('button', { name: 'Back', exact: true })
const message = (page: Page, text: string) => page.getByRole('article').filter({ hasText: text })
const actions = (page: Page) => page.getByRole('dialog', { name: 'Message actions', exact: true })
/** The general row, which a pushed screen hides but which still carries its unread state. */
const generalRow = (page: Page) =>
  page
    .getByRole('navigation', { name: 'The studio channels', exact: true, includeHidden: true })
    .locator('.nav-row', { hasText: 'general' })
/** Counts read acknowledgements the page sends from now on. */
function countReads(page: Page) {
  let reads = 0
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/read') reads += 1
  })
  return () => reads
}

async function openHome(page: Page) {
  await actAs(page, 'uiadmin')
  await page.goto(browserApp)
  await expectHome(page)
  await expect(profileBar(page).getByRole('status'), 'the live socket connects').toHaveText(
    'Connected',
  )
}
async function openChannel(page: Page, room: string, channel: string) {
  await railTile(page, room).tap()
  await channelRow(page, room, channel).tap()
  await expect(composer(page, `#${channel}`)).toBeVisible()
}

const ownMessage = 'Sounds good. No agenda, just a bit of company.'
let general: Channel | undefined
test.beforeAll(async () => {
  const admin = server.admin
  await admin.act({
    kind: 'profile.save',
    profile: { name: 'Adam Nilsson', avatar: { kind: 'mascot', shape: 'circle', color: 'teal' } },
  })
  await admin.call('/api/server/rename', { name: 'Our place' })
  const studio = Room.parse((await admin.call('/api/rooms', { name: 'The studio' })).value)
  for (const name of ['Coffee club', 'Book club']) {
    const room = Room.parse((await admin.call('/api/rooms', { name })).value)
    await admin.call('/api/channels', {
      roomId: room.id,
      name: name.split(' ')[0]?.toLowerCase(),
      kind: 'text',
    })
  }
  const channel = async (name: string, kind: 'text' | 'voice' = 'text') =>
    Channel.parse((await admin.call('/api/channels', { roomId: studio.id, name, kind })).value)
  general = await channel('general')
  for (const name of ['design', 'good-finds', 'off-topic']) await channel(name)
  for (const name of ['the-lounge', 'quiet-corner']) await channel(name, 'voice')
  const code = parseInvite(ServerInvite.parse((await admin.call('/api/invite')).value).invite).code
  const people: Client[] = []
  for (const [login, name, color] of [
    ['maya', 'Maya Lind', 'rose'],
    ['jonas', 'Jonas Berg', 'indigo'],
    ['leah', 'Leah Chen', 'sky'],
    ['nora', 'Nora West', 'amber'],
  ] as const) {
    const client = new Client(serverURL, `${login}@huddle.test`)
    await client.act({ kind: 'account.join', code, name })
    await client.act({
      kind: 'profile.save',
      profile: { name, avatar: { kind: 'mascot', shape: 'circle', color } },
    })
    people.push(client)
  }
  const [maya, jonas, leah, nora] = people
  if (!maya?.userId || !jonas?.userId || !leah || !nora || !admin.userId)
    throw new Error('The server needs its people.')
  for (const [client, body] of [
    [
      maya,
      'Morning everyone. Taking the slow route today. Anyone up for a little co-working later?',
    ],
    [jonas, 'I’m in. I’ll be in the lounge after lunch.'],
    [admin, ownMessage],
    [leah, 'Exactly what I needed today. See you there.'],
    [maya, 'Already here with Jonas if anyone wants to drop in.'],
  ] as const)
    Message.parse(
      (await client.call('/api/messages', { retryId: randomUUID(), channelId: general?.id, body }))
        .value,
    )
  async function direct(from: Client, bodies: string[]) {
    const conversation = DirectConversation.parse(
      (await from.call('/api/direct/conversations', { userId: admin.userId })).value,
    )
    const sent = []
    for (const body of bodies)
      sent.push(
        DirectMessage.parse(
          (
            await from.call('/api/direct/messages', {
              retryId: randomUUID(),
              conversationId: conversation.id,
              body,
            })
          ).value,
        ),
      )
    return { conversation, sent }
  }
  const fromNora = await direct(nora, ['That playlist is a keeper.'])
  await admin.call('/api/direct/read', {
    conversationId: fromNora.conversation.id,
    cursor: fromNora.sent[0]?.cursor,
  })
  const fromLeah = await direct(leah, ['See you in the lounge later?'])
  const reply = DirectMessage.parse(
    (
      await admin.call('/api/direct/messages', {
        retryId: randomUUID(),
        conversationId: fromLeah.conversation.id,
        body: 'See you in the lounge later.',
      })
    ).value,
  )
  await admin.call('/api/direct/read', {
    conversationId: fromLeah.conversation.id,
    cursor: reply.cursor,
  })
  await direct(jonas, ['Found the perfect spot for Saturday.'])
  const fromMaya = await direct(maya, ['Morning!', 'Are you around for a little co-working?'])
  await maya.call('/api/direct/messages/reaction', {
    conversationId: fromMaya.conversation.id,
    messageId: fromMaya.sent[0]?.id,
    emoji: '❤️',
    present: true,
    retryId: randomUUID(),
  })
  GroupObservation.parse(
    (
      await admin.call('/api/groups', {
        name: 'Weekend plans',
        retryId: randomUUID(),
        others: [maya.userId, jonas.userId],
      })
    ).value,
  )
})

test('a phone moves between Home, rooms, and conversations as one stack', async ({ page }) => {
  await openHome(page)
  const directs = main(page).getByRole('region', { name: 'Messages', exact: true })
  await expect(
    directs.getByRole('button', { name: /^Maya Lind/ }),
    'Home lists direct messages',
  ).toBeVisible()
  await expect(directs.getByRole('button', { name: /^Maya Lind/ })).toContainText(
    'Are you around for a little co-working?',
  )
  await expect(
    main(page).getByRole('region', { name: 'Your rooms' }),
    'the rail lists rooms instead',
  ).toBeHidden()
  await expect(rail(page)).toBeVisible()
  await expect(railTile(page, 'The studio')).toBeInViewport()
  await expectNoSideScroll(page)
  await capture(page, 'home')

  await railTile(page, 'The studio').tap()
  await expect(channels(page), 'a room tile shows the channel list').toBeVisible()
  await expect(main(page), 'the list fills the screen without a conversation').toBeHidden()
  const list = await channels(page).boundingBox()
  expect(list && list.x + list.width, 'the list spans to the right edge').toBeGreaterThan(
    phone.width - 24,
  )
  await expectNoSideScroll(page)
  await capture(page, 'room')

  await channelRow(page, 'The studio', 'general').tap()
  await expect(composer(page, '#general'), 'a channel row pushes its conversation').toBeVisible()
  await expect(channels(page)).toBeHidden()
  await expect(rail(page)).toBeHidden()
  await expect(
    main(page).getByText('The studio', { exact: true }),
    'the room names the channel',
  ).toBeVisible()
  await expect(message(page, 'Already here with Jonas')).toBeVisible()
  await expectNoSideScroll(page)
  await capture(page, 'channel')

  await composer(page, '#general').fill('Sent from a phone.')
  await main(page).getByRole('button', { name: 'Send message', exact: true }).tap()
  await expect(
    message(page, 'Sent from a phone.'),
    'a message sends from the pushed screen',
  ).toBeVisible()
  await expect(composer(page, '#general')).toHaveValue('')
  const maya = new Client(serverURL, 'maya@huddle.test')
  await maya.stage()
  await maya.call('/api/messages', {
    retryId: randomUUID(),
    channelId: general?.id,
    body: 'Saw that. Welcome to the small screen.',
  })
  await expect(
    message(page, 'Welcome to the small screen.'),
    'a friend’s message arrives live on the pushed screen',
  ).toBeVisible()
  await composer(page, '#general').fill('Draft that waits for me.')

  await back(page).tap()
  await expect(channels(page), 'Back returns to the channel list').toBeVisible()
  await expect(main(page)).toBeHidden()
  const reads = countReads(page)
  await maya.call('/api/messages', {
    retryId: randomUUID(),
    channelId: general?.id,
    body: 'Posted while you browse the list.',
  })
  await expect(
    channelRow(page, 'The studio', 'general'),
    'a message behind the channel list stays unread',
  ).toHaveAccessibleName('general unread')
  await page.waitForTimeout(600)
  expect(reads(), 'the hidden channel is not marked read').toBe(0)
  await channelRow(page, 'The studio', 'general').tap()
  await expect(composer(page, '#general'), 'the draft survives Back').toHaveValue(
    'Draft that waits for me.',
  )
  await expect.poll(reads, { message: 'opening the channel marks it read' }).toBeGreaterThan(0)
  await expect(generalRow(page)).not.toHaveClass(/\bunread\b/)

  const touch = await finger(page)
  const edge = { x: 6, y: phone.height / 2 }
  await touch.drag(edge, 70)
  await expect(composer(page, '#general'), 'a short swipe springs back').toBeVisible()
  await expect(channels(page)).toBeHidden()
  await expect.poll(async () => (await main(page).boundingBox())?.x).toBe(0)

  await touch.drag(edge, 220, async () => {
    const box = await main(page).boundingBox()
    expect(box?.x, 'the conversation follows the finger').toBeGreaterThan(150)
    await expect(channels(page), 'the list shows underneath while dragging').toBeVisible()
  })
  await expect(channels(page), 'a long swipe goes back').toBeVisible()
  await expect(main(page)).toBeHidden()

  await railTile(page, 'Home').tap()
  await expectHome(page)
  await directs.getByRole('button', { name: /^Maya Lind/ }).tap()
  await expect(composer(page, '@Maya Lind'), 'a direct message pushes over Home').toBeVisible()
  await expect(
    message(page, 'Morning!').getByRole('button', { name: /^Red heart love, 1, / }),
    'the direct message shows its reaction',
  ).toBeVisible()
  await expectNoSideScroll(page)
  await capture(page, 'direct')
  await back(page).tap()
  await expectHome(page)
  await expect(composer(page, '@Maya Lind')).toBeHidden()
})

test('a long press opens message actions, and a mouse never does', async ({ page }) => {
  await openHome(page)
  await openChannel(page, 'The studio', 'general')
  const own = message(page, ownMessage)
  const touch = await finger(page)

  await touch.longPress(own.getByText(ownMessage))
  await expect(actions(page), 'a long press opens message actions').toBeVisible()
  const quick = actions(page).getByRole('group', { name: 'Quick reactions' }).getByRole('button')
  expect(
    await quick.evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute('aria-label')),
    ),
  ).toEqual([
    'React with thumbs up',
    'React with red heart love',
    'React with tears of joy',
    'React with celebration party popper',
    'React with raised hands',
    'React with sparkles',
    'More reactions',
  ])
  await expect(actions(page).getByRole('button', { name: 'More reactions' })).toBeVisible()
  await expect(actions(page).getByRole('button', { name: 'Edit message' })).toBeVisible()
  await expect(actions(page).getByRole('button', { name: 'Copy text' })).toBeVisible()
  await capture(page, 'actions')
  await actions(page).getByRole('button', { name: 'React with thumbs up' }).tap()
  await expect(actions(page)).toHaveCount(0)
  await expect(
    own.getByRole('button', { name: /^Thumbs up, 1, Remove reaction/ }),
    'a quick reaction lands on the message',
  ).toBeVisible()

  await touch.longPress(message(page, 'Exactly what I needed').getByText('Exactly what I needed'))
  await expect(actions(page)).toBeVisible()
  await expect(
    actions(page).getByRole('button', { name: 'Edit message' }),
    'only your own text offers Edit',
  ).toHaveCount(0)
  const reads = countReads(page)
  const leah = new Client(serverURL, 'leah@huddle.test')
  await leah.stage()
  await leah.call('/api/messages', {
    retryId: randomUUID(),
    channelId: general?.id,
    body: 'Arrived behind the actions sheet.',
  })
  await expect(message(page, 'Arrived behind the actions sheet.')).toBeAttached()
  await expect(generalRow(page), 'a message behind the sheet stays unread').toHaveClass(
    /\bunread\b/,
  )
  await page.waitForTimeout(600)
  expect(reads(), 'nothing is marked read while the sheet covers the thread').toBe(0)
  await page.keyboard.press('Escape')
  await expect(actions(page)).toHaveCount(0)
  await expect.poll(reads, { message: 'closing the sheet marks it read' }).toBeGreaterThan(0)
  await expect(generalRow(page)).not.toHaveClass(/\bunread\b/)

  await touch.longPress(own.getByText(ownMessage))
  await actions(page).getByRole('button', { name: 'Edit message' }).tap()
  const editor = page.getByRole('textbox', { name: 'Edit message', exact: true })
  await expect(editor, 'Edit message opens the editor').toHaveValue(ownMessage)
  await page
    .getByRole('form', { name: 'Edit message' })
    .getByRole('button', { name: 'Cancel' })
    .tap()
  await expect(editor).toHaveCount(0)

  const box = await own.getByText(ownMessage).boundingBox()
  if (!box) throw new Error('The message has no box.')
  await page.mouse.click(box.x + 20, box.y + box.height / 2, { button: 'right' })
  await page.mouse.move(box.x + 20, box.y + box.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(700)
  await page.mouse.up()
  await expect(actions(page), 'a mouse right click or hold keeps the browser menu').toHaveCount(0)
})

test('the emoji and GIF sheets sit under the composer and its draft', async ({ page }) => {
  const media = await stubKlipy(page.context())
  media.feed('trending', [
    [
      media.gif('high-five-team', 'High five, team', 320, 180),
      media.gif('coffee-time', 'Coffee time', 240, 240),
      media.gif('victory-lap', 'Victory lap', 320, 180),
      media.gif('slow-wave', 'Slow wave', 240, 300),
    ],
  ])
  media.categories([
    ['Happy', 'happy'],
    ['Thanks', 'thanks'],
  ])
  await openHome(page)
  await openChannel(page, 'The studio', 'general')
  const field = composer(page, '#general')
  await field.fill('See you at')
  await main(page).getByRole('button', { name: 'Add emoji', exact: true }).tap()
  const emoji = page.getByRole('group', { name: 'Emoji picker', exact: true })
  await expect(emoji).toBeVisible()
  await expect(field, 'the composer stays on screen above the sheet').toBeInViewport({ ratio: 1 })
  await expect(field).toHaveValue('See you at')
  const sheet = await emoji.boundingBox()
  const form = await field.boundingBox()
  if (!sheet || !form) throw new Error('The sheet or the composer has no box.')
  expect(sheet.y, 'the sheet starts below the composer').toBeGreaterThanOrEqual(
    form.y + form.height,
  )
  expect(sheet.y + sheet.height, 'the sheet reaches the bottom edge').toBeGreaterThan(
    phone.height - 2,
  )
  expect(sheet.width, 'the sheet spans the screen').toBe(phone.width)
  await expect(emoji.getByRole('searchbox'), 'the keyboard stays down').not.toBeFocused()
  await capture(page, 'emoji')

  const insert = emoji.getByRole('button', { name: /^Insert / }).first()
  const symbol = ((await insert.getAttribute('aria-label')) ?? '').replace(/^Insert /, '')
  await insert.tap()
  await expect(field, 'an emoji lands in the draft').toHaveValue(`See you at${symbol}`)

  await main(page).getByRole('button', { name: 'Add emoji', exact: true }).tap()
  await emoji
    .getByRole('group', { name: 'Emoji or GIFs' })
    .getByRole('button', { name: 'GIFs' })
    .tap()
  const gifs = page.getByRole('group', { name: 'GIF picker', exact: true })
  await expect(gifs, 'the switch opens the GIF sheet').toBeVisible()
  await expect(emoji).toBeHidden()
  await expect(gifs.getByRole('button', { name: 'Victory lap, GIF', exact: true })).toBeVisible()
  await expect(field).toBeInViewport({ ratio: 1 })
  await page.evaluate(() =>
    Promise.all([...document.images].map((image) => image.decode().catch(() => {}))),
  )
  await capture(page, 'gifs')
  await gifs
    .getByRole('group', { name: 'Emoji or GIFs' })
    .getByRole('button', { name: 'Emoji' })
    .tap()
  await expect(emoji, 'the switch returns to emoji').toBeVisible()
  await expect(gifs).toBeHidden()
  expect(media.unexpected).toEqual([])
})

test('members rise as a sheet with an invite, and a person opens their card', async ({ page }) => {
  await openHome(page)
  await openChannel(page, 'The studio', 'general')
  await main(page).getByRole('button', { name: 'Member list', exact: true }).tap()
  const sheet = page.getByRole('complementary', { name: 'Server members', exact: true })
  await expect(sheet, 'the member list opens from the top bar').toBeVisible()
  await expect(sheet.getByRole('button', { name: 'Share invite', exact: true })).toBeVisible()
  await expect(sheet.getByRole('button', { name: 'View Maya Lind' })).toBeVisible()
  await expect(composer(page, '#general')).toBeAttached()
  await capture(page, 'members')

  await sheet.getByRole('button', { name: 'View Maya Lind' }).tap()
  const card = page.getByRole('dialog', { name: 'Maya Lind', exact: true })
  await expect(card, 'tapping a person opens their card').toBeVisible()
  await expect(card.getByRole('button', { name: 'Message Maya Lind' })).toBeVisible()
  await expect(card).toBeInViewport({ ratio: 1 })
  await capture(page, 'member-card')
  await card.getByRole('button', { name: 'Message Maya Lind' }).tap()
  await expect(composer(page, '@Maya Lind'), 'the card opens the direct message').toBeVisible()
})

test('Settings opens as a list of pages and keeps the draft', async ({ page }) => {
  await openHome(page)
  await openChannel(page, 'The studio', 'general')
  await composer(page, '#general').fill('Keep this while I check Settings.')
  await main(page).getByRole('button', { name: 'Channel options', exact: true }).tap()
  await page.getByRole('button', { name: 'Settings', exact: true }).tap()
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  const rows = settings.getByRole('navigation', { name: 'Settings', exact: true })
  await expect(
    rows.getByRole('button', { name: 'Profile' }),
    'Settings opens on its list',
  ).toBeVisible()
  await expect(rows.getByRole('button', { name: /^Appearance/ })).toContainText('System')
  await expect(rows.getByRole('button', { name: 'Voice', exact: true })).toBeVisible()
  await expect(rows.getByRole('button', { name: /^Connection/ })).toContainText('Online')
  await expect(settings).toContainText('Admin of Our place')
  await expect(settings.getByLabel('Name', { exact: true })).toBeHidden()
  await expectNoSideScroll(page)
  await capture(page, 'settings')

  await rows.getByRole('button', { name: 'Profile' }).tap()
  await expect(settings.getByLabel('Name', { exact: true })).toHaveValue('Adam Nilsson')
  await expect(rows, 'a page replaces the list').toBeHidden()
  await expect(
    settings.getByRole('button', { name: 'Back to settings', exact: true }),
  ).toBeFocused()
  await capture(page, 'settings-profile')
  await settings.getByRole('button', { name: 'Back to settings', exact: true }).tap()
  await expect(rows.getByRole('button', { name: 'Profile' })).toBeFocused()
  await settings.getByRole('button', { name: 'Close settings', exact: true }).tap()
  await expect(settings).toHaveCount(0)
  await expect(composer(page, '#general'), 'the draft survives Settings').toHaveValue(
    'Keep this while I check Settings.',
  )

  await main(page).getByRole('button', { name: 'Channel options', exact: true }).tap()
  await page.getByRole('button', { name: 'Settings', exact: true }).tap()
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Voice', exact: true })
    .tap()
  await page.keyboard.press('Escape')
  await expect(settings, 'Escape closes Settings from a page').toHaveCount(0)
})

test('a narrow window widens into the desktop with the same channel', async ({ page }) => {
  await openHome(page)
  await openChannel(page, 'The studio', 'design')
  await back(page).tap()
  await expect(channels(page)).toBeVisible()
  await expect(main(page)).toBeHidden()

  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(
    composer(page, '#design'),
    'the selected channel shows beside its list',
  ).toBeVisible()
  await expect(channels(page)).toBeVisible()
  await expect(rail(page)).toBeVisible()
  await expect(channelRow(page, 'The studio', 'design')).toHaveAttribute('aria-current', 'page')
  await expect(back(page), 'the desktop has no Back').toBeHidden()

  await page.setViewportSize({ width: 640, height: 740 })
  const [railBox, listBox, mainBox] = await Promise.all(
    [rail(page), channels(page), main(page)].map((locator) => locator.boundingBox()),
  )
  if (!railBox || !listBox || !mainBox) throw new Error('A column is missing at 640px.')
  expect(railBox.x + railBox.width, 'the rail sits left of the list').toBeLessThanOrEqual(listBox.x)
  expect(listBox.x + listBox.width, 'the list sits left of the conversation').toBeLessThanOrEqual(
    mainBox.x,
  )
  expect(mainBox.x + mainBox.width).toBeLessThanOrEqual(640)
  await expect(composer(page, '#design')).toBeVisible()
  await expect(back(page)).toBeHidden()
})

test('a call keeps thumb-sized controls and a pill on other screens', async ({ page, browser }) => {
  const livekit = await runningLivekit().then(
    () => true,
    () => false,
  )
  test.skip(!livekit, 'Voice needs LiveKit: docker compose --profile dev up -d livekit-dev')
  const peers: BrowserContext[] = []
  try {
    for (const login of ['maya', 'jonas']) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 860 } })
      peers.push(context)
      const peer = await context.newPage()
      await actAs(peer, login)
      await peer.goto(browserApp)
      await expectHome(peer)
      await railTile(peer, 'The studio').click()
      await channelRow(peer, 'The studio', 'the-lounge').click()
      await joinVoice(peer).click()
      await expectInCall(peer)
    }

    await openHome(page)
    await railTile(page, 'The studio').tap()
    await channelRow(page, 'The studio', 'the-lounge').tap()
    await joinVoice(page).tap()
    await expect(main(page).getByText('Voice connected'), 'the call connects').toBeVisible({
      timeout: 40000,
    })
    await expect(
      main(page).getByRole('list', { name: 'In this call' }).getByRole('listitem'),
    ).toHaveCount(3)
    for (const name of ['Mute', 'Deafen', 'Leave']) {
      const control = main(page).getByRole('button', { name, exact: true })
      await expect(control).toBeInViewport()
      const icon = await control.locator('.call-control-icon').boundingBox()
      expect(icon?.width, `${name} is at least 64px`).toBeGreaterThanOrEqual(64)
      expect(icon?.height, `${name} is at least 64px`).toBeGreaterThanOrEqual(64)
    }
    await expectNoSideScroll(page)
    await capture(page, 'voice')

    await main(page).getByRole('button', { name: 'Mute', exact: true }).tap()
    await expect(main(page).getByRole('button', { name: 'Mute', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await main(page).getByRole('button', { name: 'Mute', exact: true }).tap()
    await back(page).tap()
    await channelRow(page, 'The studio', 'general').tap()
    const pill = page.getByRole('button', { name: 'Open the-lounge', exact: true })
    await expect(pill, 'a pill stands in for the call on other screens').toBeVisible()
    await expect(pill, 'people keep the order they joined in').toContainText(
      /You, (Maya, Jonas|Jonas, Maya)/,
    )
    await pill.tap()
    await expect(
      main(page).getByRole('button', { name: 'Leave', exact: true }),
      'the pill opens the call',
    ).toBeVisible()
    await expect(pill).toHaveCount(0)
    await main(page).getByRole('button', { name: 'Leave', exact: true }).tap()
    await expect(joinVoice(page), 'Leave ends the call').toBeVisible()
  } finally {
    for (const context of peers) await context.close()
  }
})
