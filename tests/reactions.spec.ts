import { expect, test, type Page } from '@playwright/test'
import {
  Channel,
  Room,
  Message,
  DirectConversation,
  GroupObservation,
  GroupAccess,
  Snapshot,
  PhotoUpload,
} from '../packages/contracts/src/index'
import { Client, inviteCode, joinFriend, tailscale } from '../apps/server/scripts/harness'
import { member, railTile, serverURL, loginOf } from './accounts'
import { useScratchServer } from './server'

test.use({ actionTimeout: 15000 })
const fixture = useScratchServer('api')
const row = (page: Page, body: string) =>
  page
    .locator('article.message')
    .filter({ has: page.locator('.message-body').filter({ hasText: body }) })

test('a late reaction failure leaves a closed direct conversation read-only', async ({ page }) => {
  await member(fixture.admin, page, 'reaction-close', serverURL)
  const alice = new Client(serverURL, loginOf('reaction-close'))
  await alice.stage()
  const bob = new Client(serverURL, loginOf('reaction-close-bob'))
  await joinFriend(bob, await inviteCode(fixture.admin), 'Reaction peer')
  const direct = DirectConversation.parse(
    (await alice.call('/api/direct/conversations', { userId: bob.userId })).value,
  )
  await alice.call('/api/direct/messages', {
    conversationId: direct.id,
    retryId: crypto.randomUUID(),
    body: 'A reaction before removal',
  })
  await page.reload()
  await page
    .locator('.sidebar-nav')
    .getByRole('button', { name: /^Reaction peer/ })
    .click()
  const message = row(page, 'A reaction before removal')
  let ready = () => {}
  let release = () => {}
  const started = new Promise<void>((resolve) => {
    ready = resolve
  })
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(
    '**/api/direct/messages/reaction',
    async (route) => {
      ready()
      await waiting
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Unavailable' }),
      })
    },
    { times: 1 },
  )
  await message.getByRole('button', { name: 'Add reaction', exact: true }).click()
  await page
    .getByRole('group', { name: /React to/ })
    .getByRole('button', { name: 'Add reaction 👍', exact: true })
    .click()
  await started
  try {
    expect(
      (await fixture.admin.call('/api/members/remove', { userId: bob.userId })).response.status,
    ).toBe(200)
    await expect(page.locator('.composer-closed')).toBeVisible()
    const response = page.waitForResponse((res) =>
      res.url().endsWith('/api/direct/messages/reaction'),
    )
    release()
    await (await response).finished()
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    await expect(message.getByRole('alert')).toHaveCount(0)
    await expect(message.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0)
    await expect(message.getByRole('button', { name: 'Add reaction', exact: true })).toHaveCount(0)
  } finally {
    release()
  }
})
for (const theme of ['light', 'dark']) {
  test(`local color emoji and persistent reactions in every scope, ${theme}`, async ({ page }) => {
    await page.addInitScript(
      (value) => localStorage.setItem('huddle.appearance.mode', value),
      theme,
    )
    const name = `react-${theme}`
    await member(fixture.admin, page, name, serverURL)
    const alice = new Client(serverURL, loginOf(name))
    await alice.stage()
    const bob = new Client(serverURL, loginOf(name + '-bob'))
    const cal = new Client(serverURL, loginOf(name + '-cal'))
    const invite = await inviteCode(fixture.admin)
    await joinFriend(bob, invite, 'Bob')
    await joinFriend(cal, invite, 'Cal')
    const room = Room.parse(
      (await fixture.admin.call('/api/rooms', { name: 'Reactions ' + theme })).value,
    )
    const channel = Channel.parse(
      (
        await fixture.admin.call('/api/channels', {
          roomId: room.id,
          kind: 'text',
          name: 'reactions',
        })
      ).value,
    )
    const direct = DirectConversation.parse(
      (await alice.call('/api/direct/conversations', { userId: bob.userId })).value,
    )
    const group = GroupObservation.parse(
      (
        await alice.call('/api/groups', {
          name: 'Reaction group ' + theme,
          retryId: crypto.randomUUID(),
          others: [bob.userId, cal.userId],
        })
      ).value,
    ).group
    const access = GroupAccess.parse({
      groupId: group.id,
      admission: group.members.find((m) => m.userId === alice.userId)?.admission,
    })
    const scopes = [
      {
        path: '/api/messages',
        scope: { channelId: channel.id },
        open: async () => {
          await railTile(page, room.name).click()
          await page
            .locator('.sidebar-nav')
            .getByRole('button', { name: /^reactions/ })
            .click()
        },
      },
      {
        path: '/api/direct/messages',
        scope: { conversationId: direct.id },
        open: async () => {
          await railTile(page, 'Home').click()
          await page.locator('.sidebar-nav').getByRole('button', { name: /^Bob/ }).click()
        },
      },
      {
        path: '/api/group/messages',
        scope: access,
        open: async () => {
          await page
            .locator('.sidebar-nav')
            .getByRole('button', { name: new RegExp('^Reaction group ' + theme) })
            .click()
        },
      },
    ]
    const external: string[] = []
    page.on('request', (request) => {
      if (
        !request.url().startsWith(serverURL) &&
        !request.url().startsWith('data:') &&
        !request.url().startsWith('blob:')
      )
        external.push(request.url())
    })
    for (const [i, scope] of scopes.entries()) {
      const body = `Color @Bob ${i} 😊 👍🏽 ❤️‍🔥 🐈‍⬛`
      const sent = (
        await alice.call(scope.path, { ...scope.scope, retryId: crypto.randomUUID(), body })
      ).value
      await scope.open()
      const message = row(page, body)
      await expect(message).toBeVisible()
      await expect(message.locator('.mention')).toHaveText('@Bob')
      await expect(message.locator('.message-body img')).toHaveAttribute('alt', '😊')
      await expect(message.locator('.message-body')).toContainText('👍🏽 ❤️‍🔥 🐈‍⬛')
      expect(
        await message
          .locator('.message-body img')
          .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
      ).toBe(true)
      await message.getByRole('button', { name: 'Add reaction', exact: true }).focus()
      await page.keyboard.press('Enter')
      const picker = page.getByRole('group', { name: new RegExp('React to') })
      await expect(picker.getByRole('searchbox')).toBeFocused()
      await picker.getByRole('button', { name: 'Add reaction 👍', exact: true }).click()
      const pill = message.getByRole('button', { name: /Thumbs up, 1, Remove reaction/ })
      await expect(pill).toHaveAttribute('aria-pressed', 'true')
      await page.screenshot({ path: test.info().outputPath(`reactions-${theme}-${i}.png`) })
      await message.getByRole('button', { name: 'View reactions' }).focus()
      await page.keyboard.press('Enter')
      await expect(page.getByRole('group', { name: 'Reactions', exact: true })).toContainText(name)
      await page.keyboard.press('Escape')
      await expect(message.getByRole('button', { name: 'View reactions' })).toBeFocused()
      await pill.click()
      await expect(message.locator('.reaction-pill')).toHaveCount(0)
      const requests: unknown[] = []
      await page.route(
        '**' + scope.path + '/reaction',
        async (route) => {
          requests.push(route.request().postDataJSON())
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Try again' }),
          })
        },
        { times: 1 },
      )
      await message.getByRole('button', { name: 'Add reaction', exact: true }).click()
      await picker.getByRole('button', { name: 'Add reaction ❤️', exact: true }).click()
      await expect(message.getByRole('alert')).toBeVisible()
      await page.route(
        '**' + scope.path + '/reaction',
        async (route) => {
          requests.push(route.request().postDataJSON())
          await route.continue()
        },
        { times: 1 },
      )
      await message.getByRole('button', { name: 'Retry', exact: true }).click()
      await expect(message.locator('.reaction-pill')).toHaveCount(1)
      expect(requests[0]).toEqual(requests[1])
      await page.reload()
      await scope.open()
      await expect(row(page, body).locator('.reaction-pill')).toHaveCount(1)
      expect(sent).toBeTruthy()
    }
    expect(external).toEqual([])
  })
}

test('a delayed history cannot restore the last removed reaction or erase a body edit', async ({
  page,
}) => {
  await member(fixture.admin, page, 'reaction-stale', serverURL)
  const alice = new Client(serverURL, loginOf('reaction-stale'))
  await alice.stage()
  const createdRoom = Room.parse(
    (await fixture.admin.call('/api/rooms', { name: 'Stale room' })).value,
  )
  await fixture.admin.call('/api/channels', { roomId: createdRoom.id, kind: 'text', name: 'stale' })
  const snapshot = Snapshot.parse((await alice.call('/api/snapshot')).value)
  const channel = snapshot.channels.find((c) => c.kind === 'text')
  if (!channel) throw new Error('Missing channel')
  const scope = { channelId: channel.id }
  const sent = Message.parse(
    (
      await alice.call('/api/messages', {
        ...scope,
        retryId: crypto.randomUUID(),
        body: 'Stale reaction history',
      })
    ).value,
  )
  const fields = {
    ...scope,
    messageId: sent.id,
    emoji: '👍',
    present: true,
    retryId: crypto.randomUUID(),
  }
  await alice.call('/api/messages/reaction', fields)
  let release = () => {},
    ready = () => {}
  const held = new Promise<void>((resolve) => (ready = resolve))
  const wait = new Promise<void>((resolve) => (release = resolve))
  await page.route(
    '**/api/messages?**',
    async (route) => {
      const response = await route.fetch()
      ready()
      await wait
      await route.fulfill({ response })
    },
    { times: 1 },
  )
  const room = snapshot.rooms.find((r) => r.id === channel.roomId)
  if (!room) throw new Error('Missing room')
  await railTile(page, room.name).click()
  await page
    .locator('.sidebar-nav')
    .getByRole('button', { name: new RegExp('^' + channel.name) })
    .click()
  await held
  await alice.call('/api/messages/reaction', {
    ...fields,
    present: false,
    retryId: crypto.randomUUID(),
  })
  await alice.call('/api/messages/edit', {
    ...scope,
    messageId: sent.id,
    expectedRevision: '0',
    body: 'Edited despite stale history',
    retryId: crypto.randomUUID(),
  })
  await expect(row(page, 'Edited despite stale history')).toBeVisible()
  release()
  await expect(row(page, 'Edited despite stale history').locator('.reaction-pill')).toHaveCount(0)
})

test('late send and reaction responses preserve both revision axes and wrapping', async ({
  page,
}) => {
  await member(fixture.admin, page, 'reaction-responses', serverURL)
  const alice = new Client(serverURL, loginOf('reaction-responses'))
  await alice.stage()
  const room = Room.parse((await fixture.admin.call('/api/rooms', { name: 'Responses' })).value)
  const channel = Channel.parse(
    (
      await fixture.admin.call('/api/channels', {
        roomId: room.id,
        kind: 'text',
        name: 'responses',
      })
    ).value,
  )
  await railTile(page, room.name).click()
  await page
    .locator('.sidebar-nav')
    .getByRole('button', { name: /^responses/ })
    .click()
  let release = () => {},
    ready = () => {}
  const held = new Promise<void>((resolve) => (ready = resolve))
  const wait = new Promise<void>((resolve) => (release = resolve))
  let sent: Message | null = null
  await page.route(
    '**/api/messages',
    async (route) => {
      const response = await route.fetch()
      sent = Message.parse(await response.json())
      ready()
      await wait
      await route.fulfill({ response })
    },
    { times: 1 },
  )
  let releaseReaction = () => {},
    readyReaction = () => {}
  const heldReaction = new Promise<void>((resolve) => (readyReaction = resolve))
  const waitReaction = new Promise<void>((resolve) => (releaseReaction = resolve))
  await page.route(
    '**/api/messages/reaction',
    async (route) => {
      const response = await route.fetch()
      readyReaction()
      await waitReaction
      await route.fulfill({ response })
    },
    { times: 1 },
  )
  await page
    .getByRole('textbox', { name: 'Message #responses', exact: true })
    .fill('Late send response')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await held
  const getSent = () => Message.parse(sent)
  const fields = {
    channelId: channel.id,
    messageId: getSent().id,
    emoji: '👍',
    present: true,
    retryId: crypto.randomUUID(),
  }
  await alice.call('/api/messages/reaction', fields)
  const message = row(page, 'Late send response')
  await expect(message.locator('.reaction-pill')).toHaveCount(1)
  release()
  await expect(message).not.toContainText('Sending')
  await message.locator('.reaction-pill').click()
  await expect(message.getByRole('status')).toHaveText('Saving reaction…')
  await heldReaction
  await alice.call('/api/messages/edit', {
    channelId: channel.id,
    messageId: getSent().id,
    expectedRevision: '0',
    body: 'New body before reaction response',
    retryId: crypto.randomUUID(),
  })
  await alice.call('/api/messages/reaction', { ...fields, retryId: crypto.randomUUID() })
  const updated = row(page, 'New body before reaction response')
  await expect(updated.locator('.reaction-pill')).toHaveCount(1)
  releaseReaction()
  await expect(updated.getByRole('status')).toHaveCount(0)
  await expect(updated.locator('.reaction-pill')).toHaveCount(1)
  await alice.call('/api/messages', {
    channelId: channel.id,
    retryId: crypto.randomUUID(),
    body: 'Continued with wrapping reactions',
  })
  const continued = row(page, 'Continued with wrapping reactions')
  await expect(continued).toHaveClass(/continued/)
  const history = await alice.call('/api/messages?channelId=' + channel.id)
  const latest = Message.array()
    .parse(history.value)
    .find((m) => m.body === 'Continued with wrapping reactions')
  if (!latest) throw new Error('Missing continued message')
  for (const emoji of ['👍', '❤️', '😊', '🎉', '🌈', '☕', '✨', '💯', '😂', '🙌'])
    await alice.call('/api/messages/reaction', {
      channelId: channel.id,
      messageId: latest.id,
      emoji,
      present: true,
      retryId: crypto.randomUUID(),
    })
  await page.setViewportSize({ width: 760, height: 800 })
  await expect(continued.locator('.reaction-pill')).toHaveCount(10)
  const boxes = await continued.locator('.reaction-pill').evaluateAll((elements) =>
    elements.map((e) => {
      const r = e.getBoundingClientRect()
      return { left: r.left, right: r.right, top: r.top }
    }),
  )
  expect(new Set(boxes.map((b) => b.top)).size).toBeGreaterThan(1)
  for (const box of boxes) {
    expect(box.left).toBeGreaterThanOrEqual(0)
    expect(box.right).toBeLessThanOrEqual(760)
  }
})

test('reaction details load a saved photo after its owner changes their avatar', async ({
  page,
}) => {
  await member(fixture.admin, page, 'reaction-photo', serverURL)
  const alice = new Client(serverURL, loginOf('reaction-photo'))
  const stage = await alice.stage()
  if (stage.kind !== 'ready') throw new Error('The reactor must have joined')
  const room = Room.parse((await fixture.admin.call('/api/rooms', { name: 'Photo room' })).value)
  const channel = Channel.parse(
    (
      await fixture.admin.call('/api/channels', {
        roomId: room.id,
        kind: 'text',
        name: 'photos',
      })
    ).value,
  )
  const form = new FormData()
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==',
    'base64',
  )
  form.set('photo', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), 'avatar.png')
  const response = await fetch(serverURL + '/api/account/photo', {
    method: 'POST',
    headers: {
      ...tailscale(loginOf('reaction-photo')),
      Origin: serverURL,
      'X-Huddle-User': stage.user.id,
    },
    body: form,
  })
  expect(response.status).toBe(200)
  const photo = PhotoUpload.parse(await response.json())
  await alice.act({
    kind: 'profile.save',
    profile: { name: 'Photo reactor', avatar: { kind: 'photo', uploadId: photo.uploadId } },
  })
  const target = Message.parse(
    (
      await fixture.admin.call('/api/messages', {
        channelId: channel.id,
        retryId: crypto.randomUUID(),
        body: 'A photo in reaction details',
      })
    ).value,
  )
  expect(
    (
      await alice.call('/api/messages/reaction', {
        channelId: channel.id,
        messageId: target.id,
        emoji: '❤️',
        present: true,
        retryId: crypto.randomUUID(),
      })
    ).response.status,
  ).toBe(200)
  await alice.act({
    kind: 'profile.save',
    profile: { name: 'Photo reactor', avatar: { kind: 'mascot', shape: 'circle', color: 'teal' } },
  })
  await railTile(page, room.name).click()
  const message = row(page, target.body)
  await message.getByRole('button', { name: 'View reactions' }).click()
  const details = page.getByRole('group', { name: 'Reactions', exact: true })
  await expect(details.getByRole('img', { name: 'Photo reactor', exact: true })).toHaveAttribute(
    'src',
    /^data:image\/webp/,
  )
})
