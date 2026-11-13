import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { Channel, Message, Room, ServerInvite, parseInvite } from '../packages/contracts/src/index'
import { Client } from '../apps/server/scripts/harness'
import { actAs, browserApp, expectHome, railTile, serverURL } from './accounts'
import { stubKlipy } from './gifs'
import { useScratchServer } from './server'

const server = useScratchServer('api')

async function capture(page: Page, name: string) {
  await page.mouse.move(1400, 600)
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await page.evaluate(() => document.fonts.ready)
    await page.evaluate(() =>
      Promise.all(document.getAnimations().map((animation) => animation.finished)),
    )
    await expect(page.locator('.main')).toHaveCSS(
      'background-color',
      colorScheme === 'light' ? 'rgb(252, 252, 252)' : 'rgb(22, 22, 22)',
    )
    const path = test.info().outputPath(`${name}-${colorScheme}.png`)
    await page.screenshot({ path })
    await test.info().attach(`${name}-${colorScheme}`, { path, contentType: 'image/png' })
  }
}

test('GIF messages in the transcript match both themes in every state', async ({ page }) => {
  const media = await stubKlipy(page.context())
  const admin = server.admin
  await admin.act({
    kind: 'profile.save',
    profile: { name: 'Adam Nilsson', avatar: { kind: 'mascot', shape: 'circle', color: 'teal' } },
  })
  const room = Room.parse((await admin.call('/api/rooms', { name: 'The studio' })).value)
  const channel = Channel.parse(
    (await admin.call('/api/channels', { roomId: room.id, name: 'general', kind: 'text' })).value,
  )
  const code = parseInvite(ServerInvite.parse((await admin.call('/api/invite')).value).invite).code
  const people: Client[] = []
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
  if (!maya || !jonas || !leah || !admin.userId) throw new Error('The room needs its people.')
  const post = async (client: Client, content: Record<string, unknown>) =>
    Message.parse(
      (
        await client.call('/api/messages', {
          retryId: randomUUID(),
          channelId: channel.id,
          ...content,
        })
      ).value,
    )
  const highFive = media.gif('high-five-team', 'High five, team', 320, 180)
  const gone = media.gif('dancing-cat', 'Dancing cat', 240, 135)
  const victory = media.gif('victory-lap', 'Victory lap', 320, 180)
  media.hold(gone).abort()

  await post(maya, { body: 'Morning everyone. Anyone up for co-working later?' })
  await post(jonas, { body: 'I’m in. I’ll be in the lounge after lunch.' })
  const shared = await post(admin, { gif: highFive })
  for (const [client, emoji] of [
    [maya, '❤️'],
    [jonas, '👍'],
    [leah, '👍'],
  ] as const)
    await client.call('/api/messages/reaction', {
      channelId: channel.id,
      messageId: shared.id,
      emoji,
      present: true,
      retryId: randomUUID(),
    })
  await post(leah, { gif: gone })
  await post(maya, { body: 'Exactly what I needed today. See you there.' })

  await page.setViewportSize({ width: 1440, height: 900 })
  await actAs(page, 'uiadmin')
  await page.goto(browserApp)
  await expectHome(page)
  const retryId = randomUUID()
  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
    key: `huddle.outbox:${serverURL}:${admin.userId}`,
    value: JSON.stringify([
      {
        retryId,
        thread: { kind: 'channel', id: channel.id },
        gif: victory,
        kind: 'failed',
        error: 'The server could not be reached.',
      },
    ]),
  })
  await page.reload()
  await railTile(page, 'The studio').click()

  const thread = page.getByRole('main')
  const shown = thread.getByRole('img', { name: 'High five, team, GIF', exact: true })
  await expect(shown).toBeVisible()
  await expect
    .poll(() =>
      shown
        .locator('img')
        .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
    )
    .toBe(true)
  await expect(
    thread.getByRole('img', { name: 'Dancing cat, GIF unavailable', exact: true }),
  ).toBeVisible()
  const failed = thread
    .getByRole('article')
    .filter({ has: page.getByRole('img', { name: 'Victory lap, GIF', exact: true }) })
  await expect(failed.getByRole('alert')).toContainText('Couldn’t send this GIF.')
  await capture(page, 'gif-transcript')

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(shown.locator('.gif-tag')).toBeVisible()
  await expect(shown.locator('.gif-play')).toBeVisible()
  await expect
    .poll(() => shown.locator('img').evaluate((img: HTMLImageElement) => img.currentSrc))
    .toBe(highFive.still)
  await capture(page, 'gif-reduced-motion')
  await page.emulateMedia({ reducedMotion: 'no-preference' })

  let release = () => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/messages', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    await released
    await route.continue()
  })
  await failed.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect(failed).toHaveClass(/\bsending\b/)
  await capture(page, 'gif-sending')
  release()
  await expect(failed.getByRole('alert')).toHaveCount(0)
  await expect(failed).not.toHaveClass(/\bsending\b/)
  expect(media.unexpected).toEqual([])
})

test('the GIF picker matches both themes while browsing, searching, loading, and failing', async ({
  page,
}) => {
  const media = await stubKlipy(page.context())
  const tall = (slug: string, title: string, height: number) =>
    media.gif(slug, title, 498, Math.round((498 * height) / 194))
  media.feed('trending', [
    [
      tall('party-time', 'Party time', 150),
      tall('celebrate', 'Celebrate', 120),
      tall('cool', 'Cool', 160),
      tall('laughing', 'Laughing', 110),
      tall('wave', 'Wave', 170),
      tall('coffee', 'Coffee first', 140),
      tall('cheers', 'Cheers', 130),
      tall('nice', 'Nice', 150),
    ],
  ])
  media.feed('high five', [
    [
      tall('high-five-team', 'High five, team', 140),
      tall('sparkle', 'Sparkle', 110),
      tall('raise-the-roof', 'Raise the roof', 170),
      tall('clap', 'Clap', 120),
      tall('thumbs-up', 'Thumbs up', 160),
      tall('wave-back', 'Wave back', 130),
    ],
  ])
  media.categories([
    ['thank you', 'thank you'],
    ['high five', 'high five'],
    ['lol', 'lol'],
    ['good morning', 'good morning'],
  ])
  const admin = server.admin
  await admin.act({
    kind: 'profile.save',
    profile: { name: 'Adam Nilsson', avatar: { kind: 'mascot', shape: 'circle', color: 'teal' } },
  })
  const room = Room.parse((await admin.call('/api/rooms', { name: 'Weekend plans' })).value)
  const channel = Channel.parse(
    (await admin.call('/api/channels', { roomId: room.id, name: 'general', kind: 'text' })).value,
  )
  const code = parseInvite(ServerInvite.parse((await admin.call('/api/invite')).value).invite).code
  for (const [login, name, color, body] of [
    ['nora', 'Nora Holm', 'rose', 'Who’s bringing snacks on Saturday?'],
    ['eli', 'Eli Park', 'indigo', 'I’ve got chips. Someone grab drinks?'],
  ] as const) {
    const client = new Client(serverURL, `${login}@huddle.test`)
    await client.act({ kind: 'account.join', code, name })
    await client.act({
      kind: 'profile.save',
      profile: { name, avatar: { kind: 'mascot', shape: 'circle', color } },
    })
    await client.call('/api/messages', { retryId: randomUUID(), channelId: channel.id, body })
  }

  await page.setViewportSize({ width: 1440, height: 900 })
  await actAs(page, 'uiadmin')
  await page.goto(browserApp)
  await expectHome(page)
  await railTile(page, 'Weekend plans').click()
  const composer = page.getByRole('textbox', { name: 'Message #general', exact: true })
  await composer.fill('Sounds good')
  await page.getByRole('button', { name: 'Add GIF', exact: true }).click()
  const picker = page.getByRole('group', { name: 'GIF picker', exact: true })
  const search = picker.getByRole('searchbox', { name: 'Search KLIPY' })
  const drawn = () =>
    picker
      .locator('.gif-tile img')
      .evaluateAll((images) =>
        images.every((img) => img instanceof HTMLImageElement && img.complete && img.naturalWidth),
      )
  await expect(picker.getByRole('button', { name: 'Cheers, GIF', exact: true })).toBeVisible()
  await expect.poll(drawn).toBe(true)
  await expect(picker).toHaveCSS('width', '420px')
  await expect(picker).toHaveCSS('height', '480px')
  const [pickerBox, composerBox] = await Promise.all([
    picker.boundingBox(),
    page.locator('.composer').boundingBox(),
  ])
  if (!pickerBox || !composerBox) throw new Error('The picker or composer is missing.')
  expect(pickerBox.y + pickerBox.height).toBeLessThanOrEqual(composerBox.y - 8)
  expect(pickerBox.x).toBe(composerBox.x)
  await capture(page, 'gif-picker-browse')

  await search.fill('high five')
  await expect(picker.getByRole('button', { name: 'Thumbs up, GIF', exact: true })).toBeVisible()
  await expect.poll(drawn).toBe(true)
  await search.press('ArrowDown')
  await expect(picker.getByRole('button', { name: 'High five, team, GIF' })).toBeFocused()
  await capture(page, 'gif-picker-search')

  const release = media.holdFeed('party')
  await search.fill('party')
  await expect(picker.locator('.gif-skeleton').first()).toBeVisible()
  await capture(page, 'gif-picker-loading')
  release()

  await search.fill('zxqv')
  await expect(picker.getByRole('status')).toContainText('No GIFs for “zxqv”')
  await capture(page, 'gif-picker-empty')

  media.fail('outage')
  await search.fill('outage')
  await expect(picker.getByRole('alert')).toContainText('Couldn’t load GIFs')
  await capture(page, 'gif-picker-unreachable')
  expect(media.unexpected).toEqual([])
})
