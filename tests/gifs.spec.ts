import { randomUUID } from 'node:crypto'
import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  Channel,
  DirectConversation,
  GroupAccess,
  DirectMessage,
  GroupObservation,
  Message,
  Room,
  type GifRef,
} from '../packages/contracts/src/index'
import { Client, inviteCode, joinFriend } from '../apps/server/scripts/harness'
import { loginOf, member, railTile, serverURL } from './accounts'
import { stubKlipy } from './gifs'
import { useScratchServer } from './server'

test.use({ actionTimeout: 15000 })
const server = useScratchServer('api')

type Scope = {
  path: string
  access: (who: Client) => Record<string, unknown>
  open: () => Promise<void>
}
const shown = (page: Page, title: string) =>
  page.getByRole('img', { name: `${title}, GIF`, exact: true })
const gifRow = (page: Page, title: string) =>
  page.getByRole('article').filter({ has: shown(page, title) })
const textRow = (page: Page, body: string) =>
  page.getByRole('article').filter({ has: page.locator('.message-body').filter({ hasText: body }) })
const editor = (page: Page) => page.getByRole('form', { name: 'Edit message', exact: true })
const drawn = (gif: Locator) =>
  gif
    .locator('img')
    .evaluate((img: HTMLImageElement) =>
      img.complete && img.naturalWidth > 0 ? img.currentSrc : '',
    )
const size = async (locator: Locator) => {
  const box = await locator.boundingBox()
  if (!box) throw new Error('Not on screen.')
  return [Math.round(box.width), Math.round(box.height)]
}
const outbox = (page: Page, key: string) =>
  page.evaluate(
    (key) =>
      (JSON.parse(localStorage.getItem(key) ?? '[]') as { retryId: string }[]).map(
        (entry) => entry.retryId,
      ),
    key,
  )

async function send(who: Client, scope: Scope, content: { body: string } | { gif: GifRef }) {
  const { response, value } = await who.call(scope.path, {
    ...scope.access(who),
    retryId: randomUUID(),
    ...content,
  })
  expect(response.status, JSON.stringify(value)).toBe(200)
}

async function circle(page: Page, name: string, path = serverURL) {
  await member(server.admin, page, name, path)
  const me = new Client(serverURL, loginOf(name))
  await me.stage()
  const friend = new Client(serverURL, loginOf(`${name}-friend`))
  const other = new Client(serverURL, loginOf(`${name}-other`))
  const invite = await inviteCode(server.admin)
  const friendName = `Friend ${name}`
  await joinFriend(friend, invite, friendName)
  await joinFriend(other, invite, `Other ${name}`)
  const room = Room.parse((await server.admin.call('/api/rooms', { name: `Loops ${name}` })).value)
  const channel = Channel.parse(
    (await server.admin.call('/api/channels', { roomId: room.id, kind: 'text', name: 'gifs' }))
      .value,
  )
  const direct = DirectConversation.parse(
    (await me.call('/api/direct/conversations', { userId: friend.userId })).value,
  )
  const groupName = `Group ${name}`
  const group = GroupObservation.parse(
    (
      await me.call('/api/groups', {
        name: groupName,
        retryId: randomUUID(),
        others: [friend.userId, other.userId],
      })
    ).value,
  ).group
  const groupAccess = (who: Client) =>
    GroupAccess.parse({
      groupId: group.id,
      admission: group.members.find((person) => person.userId === who.userId)?.admission,
    })
  const sidebar = page.locator('.sidebar-nav')
  const scopes: [Scope, Scope, Scope] = [
    {
      path: '/api/messages',
      access: () => ({ channelId: channel.id }),
      open: async () => {
        await railTile(page, room.name).click()
        await sidebar.getByRole('button', { name: /^gifs/ }).click()
      },
    },
    {
      path: '/api/direct/messages',
      access: () => ({ conversationId: direct.id }),
      open: async () => {
        await railTile(page, 'Home').click()
        await sidebar.getByRole('button', { name: new RegExp(`^${friendName}`) }).click()
      },
    },
    {
      path: '/api/group/messages',
      access: groupAccess,
      open: async () => {
        await railTile(page, 'Home').click()
        await sidebar.getByRole('button', { name: new RegExp(`^${groupName}`) }).click()
      },
    },
  ]
  return { me, friend, friendName, channel, direct, scopes }
}

test('a GIF is its own message in a channel, a direct message, and a group', async ({ page }) => {
  const media = await stubKlipy(page.context())
  const { me, friend, friendName, scopes } = await circle(page, 'gif-scopes')
  for (const [index, scope] of scopes.entries()) {
    const mine = media.gif(`mine-${index}`, `High five ${index}`, 498, 280)
    const words = `Plain words ${index}`
    await send(me, scope, { body: words })
    await send(me, scope, { gif: mine })
    await scope.open()
    const own = shown(page, mine.title)
    await expect(own).toBeVisible()
    await expect.poll(() => drawn(own)).toBe(mine.animated)
    expect(await size(own)).toEqual([400, 225])

    await expect(textRow(page, words).getByRole('button', { name: 'Edit message' })).toHaveCount(1)
    await expect(
      gifRow(page, mine.title).getByRole('button', { name: 'Edit message' }),
    ).toHaveCount(0)
    await own.dblclick()
    await expect(editor(page)).toHaveCount(0)
    await textRow(page, words).locator('.message-body').dblclick()
    await expect(editor(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(editor(page)).toHaveCount(0)

    const theirs = media.gif(`theirs-${index}`, `Wave ${index}`, 300, 600)
    await send(friend, scope, { gif: theirs })
    const live = shown(page, theirs.title)
    await expect(live).toBeVisible()
    await expect.poll(() => drawn(live)).toBe(theirs.animated)
    expect(await size(live)).toEqual([150, 300])
    await gifRow(page, theirs.title)
      .getByRole('button', { name: 'Add reaction', exact: true })
      .click()
    await page
      .getByRole('group', { name: /React to/ })
      .getByRole('button', { name: 'Add reaction 👍', exact: true })
      .click()
    await expect(
      gifRow(page, theirs.title).getByRole('button', { name: /Thumbs up, 1, Remove reaction/ }),
    ).toHaveAttribute('aria-pressed', 'true')
  }

  await send(me, scopes[1], { gif: media.gif('last-word', 'Last word') })
  await railTile(page, 'Home').click()
  await expect(
    page.getByRole('main').getByRole('button', { name: new RegExp(`^${friendName}`) }),
  ).toContainText('You: GIF · Last word')

  expect(media.unexpected).toEqual([])
  expect(media.seen.length).toBeGreaterThan(0)
  expect(media.seen.filter((request) => request.referer || request.cookie)).toEqual([])
})

test('under reduced motion a GIF shows its still with a GIF tag until hover or focus', async ({
  page,
}) => {
  const media = await stubKlipy(page.context())
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const { me, scopes } = await circle(page, 'gif-still')
  const gif = media.gif('slow-wave', 'Slow wave')
  await send(me, scopes[0], { gif })
  await scopes[0].open()
  const loop = shown(page, gif.title)
  const tag = loop.locator('.gif-tag')
  const play = loop.locator('.gif-play')
  await expect.poll(() => drawn(loop)).toBe(gif.still)
  await expect(tag).toHaveText('GIF')
  await expect(tag).toBeVisible()
  await expect(play).toBeVisible()

  await loop.hover()
  await expect.poll(() => drawn(loop)).toBe(gif.animated)
  await expect(tag).toBeHidden()
  await expect(play).toBeHidden()
  await page.mouse.move(1, 1)
  await expect.poll(() => drawn(loop)).toBe(gif.still)
  await expect(tag).toBeVisible()

  await loop.focus()
  await expect.poll(() => drawn(loop)).toBe(gif.animated)
  await expect(tag).toBeHidden()
  await loop.blur()
  await expect.poll(() => drawn(loop)).toBe(gif.still)

  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await expect.poll(() => drawn(loop)).toBe(gif.animated)
  await expect(tag).toBeHidden()
  expect(media.unexpected).toEqual([])
})

test('a GIF that cannot load keeps its box and says it is unavailable', async ({ page }) => {
  const media = await stubKlipy(page.context())
  const { me, scopes } = await circle(page, 'gif-gone')
  const gone = media.gif('gone-soon', 'Gone soon', 480, 360)
  const held = media.hold(gone)
  await send(me, scopes[0], { gif: gone })
  await send(me, scopes[0], { body: 'After the GIF' })
  await scopes[0].open()
  const loading = shown(page, gone.title)
  await expect(loading).toBeVisible()
  expect(await drawn(loading)).toBe('')
  const after = textRow(page, 'After the GIF')
  const [box, next] = [await loading.boundingBox(), await after.boundingBox()]
  expect(await size(loading)).toEqual([400, 300])

  held.abort()
  const unavailable = page.getByRole('img', { name: 'Gone soon, GIF unavailable', exact: true })
  await expect(unavailable).toBeVisible()
  await expect(unavailable).toHaveText('GIF unavailable')
  expect(await unavailable.boundingBox()).toEqual(box)
  expect(await after.boundingBox()).toEqual(next)
  await expect(gifRow(page, gone.title)).toHaveCount(0)
  expect(media.unexpected).toEqual([])
})

test('a failed GIF waits in the outbox, tries again as the same GIF, and can be discarded', async ({
  page,
}) => {
  const media = await stubKlipy(page.context())
  const { me, friend, channel, direct, scopes } = await circle(page, 'gif-outbox')
  const retried = media.gif('try-again', 'Try again later')
  const dropped = media.gif('never-mind', 'Never mind')
  const ids = { text: randomUUID(), retried: randomUUID(), dropped: randomUUID() }
  const key = `huddle.outbox:${serverURL}:${me.userId}`
  const thread = { kind: 'channel', id: channel.id }
  await page.goto(`${serverURL}/api/info`)
  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
    key,
    value: JSON.stringify([
      { retryId: 'not-a-message-id', thread, gif: { slug: 5 }, kind: 'failed' },
      { retryId: ids.text, thread, body: 'Text keeps its retry', kind: 'failed', error: 'x' },
      { retryId: ids.retried, thread, gif: retried, kind: 'failed', error: 'x' },
      {
        retryId: ids.dropped,
        thread: { kind: 'direct', id: direct.id },
        peerId: friend.userId,
        gif: dropped,
        kind: 'failed',
        error: 'x',
      },
    ]),
  })
  await page.goto(serverURL)
  await scopes[0].open()

  const text = textRow(page, 'Text keeps its retry')
  await expect(text.getByRole('alert')).toContainText('Couldn’t send this message.')
  await expect(text.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
  await expect(text.getByRole('button', { name: 'Discard', exact: true })).toHaveCount(0)
  const failed = gifRow(page, retried.title)
  await expect(failed.getByRole('alert')).toContainText('Couldn’t send this GIF.')
  await expect(failed.getByRole('button', { name: 'Discard', exact: true })).toBeVisible()
  await expect(failed.locator('.gif-message')).toHaveCSS('opacity', '1')

  const posted: unknown[] = []
  let arrived = () => {}
  const reached = new Promise<void>((resolve) => {
    arrived = resolve
  })
  let answer = () => {}
  const answered = new Promise<void>((resolve) => {
    answer = resolve
  })
  await page.route('**/api/messages', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    posted.push(route.request().postDataJSON())
    if (posted.length > 1) return route.continue()
    arrived()
    await answered
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'The server could not be reached.' }),
    })
  })
  await failed.getByRole('button', { name: 'Try again', exact: true }).click()
  await reached
  await expect(failed).toHaveClass(/\bsending\b/)
  await expect(failed.locator('.gif-message')).toHaveCSS('opacity', '0.5')
  await expect(failed.getByText('Sending…')).toBeVisible()
  answer()
  await expect(failed.getByRole('alert')).toContainText('Couldn’t send this GIF.')
  await failed.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect(failed.getByRole('alert')).toHaveCount(0)
  await expect(failed.locator('time')).toBeVisible()
  expect(posted).toEqual([
    { channelId: channel.id, retryId: ids.retried, gif: retried },
    { channelId: channel.id, retryId: ids.retried, gif: retried },
  ])
  const history = Message.array().parse(
    (await friend.call(`/api/messages?channelId=${channel.id}`)).value,
  )
  expect(history.filter((message) => message.retryId === ids.retried).map((m) => m.gif)).toEqual([
    retried,
  ])
  expect(await outbox(page, key)).toEqual([ids.text, ids.dropped])

  await scopes[1].open()
  const discarded = gifRow(page, dropped.title)
  await expect(discarded.getByRole('alert')).toContainText('Couldn’t send this GIF.')
  await discarded.getByRole('button', { name: 'Discard', exact: true }).click()
  await expect(discarded).toHaveCount(0)
  expect(await outbox(page, key)).toEqual([ids.text])
  await page.reload()
  await scopes[0].open()
  await expect(textRow(page, 'Text keeps its retry')).toBeVisible()
  expect(await outbox(page, key)).toEqual([ids.text])
  await expect(page.getByText(dropped.title)).toHaveCount(0)
  const directHistory = DirectMessage.array().parse(
    (await friend.call(`/api/direct/messages?conversationId=${direct.id}`)).value,
  )
  expect(directHistory).toEqual([])
  expect(media.unexpected).toEqual([])
})

const picker = (page: Page) => page.getByRole('group', { name: 'GIF picker', exact: true })
const searchBox = (page: Page) => picker(page).getByRole('searchbox', { name: 'Search KLIPY' })
const section = (page: Page) => picker(page).locator('.emoji-section')
const footer = (page: Page) => picker(page).locator('.gif-footer')
const tileNames = (page: Page) =>
  picker(page)
    .locator('.gif-masonry > [aria-label]')
    .evaluateAll((tiles) => tiles.map((tile) => tile.getAttribute('aria-label')))
const tile = (page: Page, title: string) =>
  picker(page).getByRole('button', { name: `${title}, GIF`, exact: true })
const focusedName = (page: Page) =>
  page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '')
const searches = (media: Awaited<ReturnType<typeof stubKlipy>>) =>
  media.api
    .filter((request) => request.url.pathname.endsWith('/search'))
    .map((request) => request.url.searchParams.get('q'))
const draft = (page: Page) => page.getByRole('textbox', { name: /^Message / })

test('the GIF picker asks KLIPY only once open, keeps its order, and sends from search by keyboard', async ({
  page,
}) => {
  const media = await stubKlipy(page.context())
  const party = media.gif('party-time', 'Party time', 498, 498)
  const wave = media.gif('wave-hello', 'Wave hello', 498, 280)
  const cool = media.gif('cool', 'Cool', 400, 400)
  media.feed('trending', [
    [
      party,
      media.flawed('cheers', 'Cheers', 'no still'),
      wave,
      media.flawed('shady', 'Shady', 'off host'),
      cool,
    ],
  ])
  const highFive = media.gif('high-five-team', 'High five, team', 498, 360)
  const sparkle = media.gif('sparkle', 'Sparkle', 498, 300)
  const clap = media.gif('clap', 'Clap', 498, 280)
  const roof = media.gif('raise-the-roof', 'Raise the roof', 300, 400)
  media.feed('high five', [[highFive, sparkle, clap, roof]])
  media.feed('slow', [[media.gif('slow-one', 'Slow one')]])
  media.categories([
    ['high five', 'high five'],
    ['thank you', 'thanks'],
    ['lol', 'lol'],
  ])
  const { friend, channel, scopes } = await circle(page, 'gif-pick')
  await scopes[0].open()
  await draft(page).fill('Sounds good')
  await expect(
    page
      .locator('.composer-actions > button')
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label'))),
  ).resolves.toEqual(['Add mention', 'Add emoji', 'Add GIF', 'Send message'])
  expect(media.api).toEqual([])

  const gifButton = page.getByRole('button', { name: 'Add GIF', exact: true })
  await gifButton.click()
  await expect(searchBox(page)).toBeFocused()
  await expect(searchBox(page)).toHaveAttribute('placeholder', 'Search KLIPY')
  await expect
    .poll(() => tileNames(page))
    .toEqual([
      'Party time, GIF',
      'Cheers, GIF unavailable',
      'Wave hello, GIF',
      'Shady, GIF unavailable',
      'Cool, GIF',
    ])
  await expect(picker(page).getByRole('img', { name: 'Cheers, GIF unavailable' })).toHaveText(
    'GIF unavailable',
  )
  await expect(section(page)).toHaveText('Trending')
  await expect(footer(page)).toHaveText('Powered by KLIPY')
  const chips = picker(page).getByRole('group', { name: 'GIF categories' }).getByRole('button')
  await expect(chips).toHaveText(['Trending', 'Recent', 'High five', 'Thank you', 'Lol'])
  await expect(chips.first()).toHaveAttribute('aria-pressed', 'true')
  expect(
    media.api
      .map(({ url, referer, cookie }) => ({
        path: url.pathname,
        params: Object.fromEntries(url.searchParams),
        referer,
        cookie,
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  ).toEqual([
    {
      path: '/api/v1/huddle-suite-klipy-key/gifs/categories',
      params: {},
      referer: undefined,
      cookie: undefined,
    },
    {
      path: '/api/v1/huddle-suite-klipy-key/gifs/trending',
      params: { page: '1', per_page: '24', content_filter: 'medium', format_filter: 'webp,jpg' },
      referer: undefined,
      cookie: undefined,
    },
  ])

  const release = media.holdFeed('slow')
  await searchBox(page).fill('slow')
  await expect.poll(() => searches(media)).toEqual(['slow'])
  await searchBox(page).clear()
  await searchBox(page).pressSequentially('high five', { delay: 30 })
  await expect
    .poll(() => tileNames(page))
    .toEqual(['High five, team, GIF', 'Sparkle, GIF', 'Clap, GIF', 'Raise the roof, GIF'])
  release()
  await page.waitForTimeout(500)
  await expect(tile(page, 'Slow one')).toHaveCount(0)
  expect(searches(media)).toEqual(['slow', 'high five'])
  await expect(section(page)).toHaveText('GIFs for “high five”')
  await expect(picker(page).getByRole('group', { name: 'GIF categories' })).toHaveCount(0)

  const walk: [key: string, name: string][] = [
    ['ArrowDown', 'High five, team, GIF'],
    ['ArrowRight', 'Sparkle, GIF'],
    ['ArrowDown', 'Clap, GIF'],
    ['ArrowLeft', 'Raise the roof, GIF'],
    ['ArrowUp', 'High five, team, GIF'],
    ['ArrowUp', 'Search KLIPY'],
    ['ArrowDown', 'High five, team, GIF'],
    ['ArrowRight', 'Sparkle, GIF'],
  ]
  for (const [key, name] of walk) {
    await page.keyboard.press(key)
    await expect.poll(() => focusedName(page), `${key} reaches ${name}`).toBe(name)
  }
  const [left, right, below] = await Promise.all(
    [highFive, sparkle, clap].map((gif) => tile(page, gif.title).boundingBox()),
  )
  expect(right!.x).toBeGreaterThan(left!.x + left!.width)
  expect(below!.x).toBe(right!.x)
  expect(below!.y).toBeGreaterThan(right!.y + right!.height)
  await expect(footer(page)).toHaveText(/^Sparkle\s*Powered by KLIPY$/)

  await page.keyboard.press('Enter')
  await expect(picker(page)).toBeHidden()
  await expect(draft(page)).toBeFocused()
  await expect(draft(page)).toHaveValue('Sounds good')
  await expect(shown(page, 'Sparkle')).toBeVisible()
  await expect
    .poll(async () =>
      Message.array()
        .parse((await friend.call(`/api/messages?channelId=${channel.id}`)).value)
        .map((message) => message.gif),
    )
    .toEqual([sparkle])

  await gifButton.click()
  await expect(searchBox(page)).toHaveValue('')
  await expect(section(page)).toHaveText('Trending')
  await chips.filter({ hasText: 'Recent' }).click()
  await expect.poll(() => tileNames(page)).toEqual(['Sparkle, GIF'])
  await page.keyboard.press('Escape')
  await expect(picker(page)).toBeHidden()
  await expect(draft(page)).toBeFocused()
  await expect(draft(page)).toHaveValue('Sounds good')
  expect(media.unexpected).toEqual([])
  expect(media.seen.filter((request) => request.referer || request.cookie)).toEqual([])
})

test('on the desktop frontend the picker loads, pages on, browses, and recovers from no results and outages', async ({
  page,
}) => {
  const media = await stubKlipy(page.context())
  const first = Array.from({ length: 24 }, (_, index) =>
    media.gif(`trend-${index}`, `Trend ${index}`, 498, 280 + (index % 4) * 70),
  )
  const second = Array.from({ length: 6 }, (_, index) =>
    media.gif(`more-${index}`, `More ${index}`),
  )
  media.feed('trending', [first, second])
  media.feed('thanks', [[media.gif('thanks-a-lot', 'Thanks a lot')]])
  media.categories([
    ['thank you', 'thanks'],
    ['lol', 'lol'],
  ])
  const { scopes } = await circle(page, 'gif-browse', '/')
  await scopes[0].open()
  await draft(page).fill('Still here')
  const release = media.holdFeed('trending')
  await page.getByRole('button', { name: 'Add GIF', exact: true }).click()
  await expect(picker(page).getByRole('status')).toHaveText('Loading GIFs')
  await expect(picker(page).locator('.gif-skeleton')).toHaveCount(6)
  release()
  await expect.poll(() => tileNames(page)).toEqual(first.map((gif) => `${gif.title}, GIF`))

  await picker(page)
    .locator('.gif-grid')
    .evaluate((grid) => grid.scrollTo({ top: grid.scrollHeight }))
  await expect
    .poll(() => tileNames(page))
    .toEqual([...first, ...second].map((gif) => `${gif.title}, GIF`))
  expect(
    media.api
      .filter((request) => request.url.pathname.endsWith('/trending'))
      .map((request) => request.url.searchParams.get('page')),
  ).toEqual(['1', '2'])

  const chips = picker(page).getByRole('group', { name: 'GIF categories' }).getByRole('button')
  await chips.filter({ hasText: 'Thank you' }).click()
  await expect.poll(() => tileNames(page)).toEqual(['Thanks a lot, GIF'])
  await expect(section(page)).toHaveText('Thank you')
  await expect(chips.filter({ hasText: 'Thank you' })).toHaveAttribute('aria-pressed', 'true')
  expect(searches(media)).toEqual(['thanks'])

  await searchBox(page).fill('zxqv')
  const empty = picker(page).getByRole('status')
  await expect(empty).toContainText('No GIFs for “zxqv”')
  await expect(empty).toContainText('Try a different word, or browse a category.')
  await expect(empty.getByRole('button')).toHaveText(['Trending', 'Thank you', 'Lol'])
  await empty.getByRole('button', { name: 'Trending', exact: true }).click()
  await expect(searchBox(page)).toHaveValue('')
  await expect(searchBox(page)).toBeFocused()
  await expect(section(page)).toHaveText('Trending')
  await expect.poll(() => tileNames(page)).toEqual(first.map((gif) => `${gif.title}, GIF`))

  media.fail('outage')
  await searchBox(page).fill('outage')
  const outage = picker(page).getByRole('alert')
  await expect(outage).toContainText('Couldn’t load GIFs')
  await expect(outage).toContainText('Your draft is unchanged.')
  await expect(draft(page)).toHaveValue('Still here')
  media.restore('outage')
  const back = media.gif('back-again', 'Back again')
  media.feed('outage', [[back]])
  await outage.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect.poll(() => tileNames(page)).toEqual(['Back again, GIF'])
  await expect(outage).toHaveCount(0)

  const picture = tile(page, back.title).locator('img')
  const drawn = () =>
    picture.evaluate((img: HTMLImageElement) => (img.complete ? img.currentSrc : ''))
  await expect.poll(drawn).toBe(`https://static2.klipy.com/ii/${back.slug}/sm.webp`)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect.poll(drawn).toBe(back.still)
  await page.emulateMedia({ reducedMotion: 'no-preference' })

  await tile(page, back.title).click()
  await expect(picker(page)).toBeHidden()
  await expect(draft(page)).toBeFocused()
  await expect(draft(page)).toHaveValue('Still here')
  await expect(shown(page, back.title)).toBeVisible()
  expect(media.unexpected).toEqual([])
})

test('a GIF picked in a group that fails to send waits as failed through a reload, and Discard drops it', async ({
  page,
}) => {
  const media = await stubKlipy(page.context())
  const oops = media.gif('oops', 'Oops')
  media.feed('trending', [[oops]])
  const { me, scopes } = await circle(page, 'gif-group-failure')
  await page.route('**/api/group/messages', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 500, json: { error: 'The server could not be reached.' } })
      : route.continue(),
  )
  await scopes[2].open()
  await page.getByRole('button', { name: 'Add GIF', exact: true }).click()
  await tile(page, oops.title).click()
  const failed = gifRow(page, oops.title)
  await expect(failed.getByRole('alert')).toContainText('Couldn’t send this GIF.')
  await expect(failed.getByRole('button', { name: 'Try again', exact: true })).toBeVisible()
  const key = `huddle.outbox:${serverURL}:${me.userId}`
  const stored = () =>
    page.evaluate(
      (key) =>
        (JSON.parse(localStorage.getItem(key) ?? '[]') as { gif?: GifRef }[]).map(
          (entry) => entry.gif,
        ),
      key,
    )
  expect(await stored()).toEqual([oops])
  await page.reload()
  await scopes[2].open()
  await expect(failed.getByRole('alert')).toContainText('Couldn’t send this GIF.')
  await expect(failed.getByRole('button', { name: 'Try again', exact: true })).toBeVisible()
  expect(await stored()).toEqual([oops])
  await failed.getByRole('button', { name: 'Discard', exact: true }).click()
  await expect(failed).toHaveCount(0)
  expect(await stored()).toEqual([])
  expect(media.unexpected).toEqual([])
})

test('there is no GIF button without a KLIPY key or in a read-only direct message', async ({
  page,
}) => {
  const media = await stubKlipy(page.context())
  const { me, friend, scopes } = await circle(page, 'gif-absent')
  const gifButton = page.getByRole('button', { name: 'Add GIF', exact: true })
  await send(me, scopes[1], { body: 'See you soon' })
  await scopes[1].open()
  await expect(gifButton).toBeVisible()
  const removal = await server.admin.call('/api/members/remove', { userId: friend.userId })
  expect(removal.response.status).toBe(200)
  await expect(page.locator('.composer-closed')).toBeVisible()
  await expect(gifButton).toHaveCount(0)

  await page.route('**/api/snapshot', async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...(await response.json()), gifs: null } })
  })
  await page.reload()
  await scopes[0].open()
  await expect(page.getByRole('button', { name: 'Add emoji', exact: true })).toBeVisible()
  await expect(gifButton).toHaveCount(0)
  expect(media.api).toEqual([])
})
