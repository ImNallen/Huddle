import { expect, test, type Page, type Route } from '@playwright/test'
import {
  Channel,
  Room,
  Message,
  DirectConversation,
  DirectMessage,
  GroupObservation,
  GroupAccess,
  GroupMessage,
  Snapshot,
  UserId,
  type GroupConversation,
} from '../packages/contracts/src/index'
import { Client } from '../apps/server/scripts/harness'
import { member, railTile, serverURL, loginOf } from './accounts'
import { useScratchServer } from './server'
import {
  initialGroups,
  observeGroup,
  groupMessage,
  groupThread,
} from '../packages/ui/src/groupState'

test.use({ actionTimeout: 15000 })
const fixture = useScratchServer('api')
const sidebar = (page: Page) => page.locator('.sidebar-nav')
const row = (page: Page, body: string) =>
  page
    .locator('article.message')
    .filter({ has: page.locator('.message-body').filter({ hasText: body }) })
async function author(page: Page, name: string) {
  await member(fixture.admin, page, name, serverURL)
  const client = new Client(serverURL, loginOf(name))
  await client.stage()
  return client
}
async function peer(name: string) {
  const client = new Client(serverURL, loginOf(name))
  const { inviteCode, joinFriend } = await import('../apps/server/scripts/harness')
  await joinFriend(client, await inviteCode(fixture.admin), name)
  return client
}
async function hold(page: Page, pattern: string) {
  let release = () => {},
    ready = () => {},
    done = () => {}
  const held = new Promise<void>((resolve) => (ready = resolve))
  const wait = new Promise<void>((resolve) => (release = resolve))
  const finished = new Promise<void>((resolve) => (done = resolve))
  await page.route(
    pattern,
    async (route: Route) => {
      const response = await route.fetch()
      ready()
      await wait
      await route.fulfill({ response }).catch(() => {})
      done()
    },
    { times: 1 },
  )
  return {
    held,
    release: async () => {
      release()
      await finished
    },
  }
}
const access = (group: GroupConversation, userId: string | null) =>
  GroupAccess.parse({
    groupId: group.id,
    admission: group.members.find((m) => m.userId === userId)?.admission,
  })

test('own persisted channel, direct and group messages have independent accessible editors', async ({
  page,
}) => {
  const alice = await author(page, 'edit-ui-alice')
  const bob = await peer('edit-ui-bob'),
    cal = await peer('edit-ui-cal')
  const room = Room.parse((await fixture.admin.call('/api/rooms', { name: 'Editing' })).value)
  const channel = Channel.parse(
    (
      await fixture.admin.call('/api/channels', {
        roomId: room.id,
        kind: 'text',
        name: 'corrections',
      })
    ).value,
  )
  const direct = DirectConversation.parse(
    (await alice.call('/api/direct/conversations', { userId: bob.userId })).value,
  )
  const group = GroupObservation.parse(
    (
      await alice.call('/api/groups', {
        name: 'Edit group',
        retryId: crypto.randomUUID(),
        others: [bob.userId, cal.userId],
      })
    ).value,
  ).group
  const scopes = [
    {
      path: '/api/messages',
      scope: { channelId: channel.id },
      open: async () => {
        await railTile(page, room.name).click()
        await sidebar(page)
          .getByRole('button', { name: /^corrections/ })
          .click()
      },
    },
    {
      path: '/api/direct/messages',
      scope: { conversationId: direct.id },
      open: async () => {
        await railTile(page, 'Home').click()
        await sidebar(page)
          .getByRole('button', { name: /^edit-ui-bob/ })
          .click()
      },
    },
    {
      path: '/api/group/messages',
      scope: access(group, alice.userId),
      open: async () => {
        await sidebar(page)
          .getByRole('button', { name: /^Edit group/ })
          .click()
      },
    },
  ]
  for (const [index, scope] of scopes.entries()) {
    const body = `Original ${index}`
    await alice.call(scope.path, { ...scope.scope, retryId: crypto.randomUUID(), body })
    const otherScope = index === 2 ? access(group, bob.userId) : scope.scope
    await bob.call(scope.path, {
      ...otherScope,
      retryId: crypto.randomUUID(),
      body: `Peer ${index}`,
    })
    if (index === 0) await page.reload()
    await scope.open()
    await expect(
      row(page, `Peer ${index}`).getByRole('button', { name: 'Edit message' }),
    ).toHaveCount(0)
    const composer = page.locator('textarea#message')
    await composer.fill('Independent unsent draft')
    await row(page, body).getByRole('button', { name: 'Edit message' }).focus()
    await page.keyboard.press('Enter')
    const editor = page.getByRole('textbox', { name: 'Edit message', exact: true })
    await expect(editor).toBeFocused()
    await expect(editor).toHaveCSS('height', '96px')
    await expect(editor).toHaveCSS('padding-top', '12px')
    await expect(editor).toHaveCSS('font-size', '15px')
    await editor.fill('Cancelled correction')
    await editor.press('Escape')
    await expect(row(page, body).getByRole('button', { name: 'Edit message' })).toBeFocused()
    await row(page, body).getByRole('button', { name: 'Edit message' }).click()
    await editor.fill('')
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    await expect(editor).toHaveAttribute('placeholder', 'Edit your message')
    await expect(page.getByText('Enter a message to save.', { exact: true })).toBeVisible()
    if (index === 0)
      for (const theme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: theme })
        await page
          .locator('.message-editor')
          .screenshot({ path: `test-results/editing-empty-${theme}.png`, animations: 'disabled' })
      }
    await editor.fill(`Corrected ${index}`)
    await page.emulateMedia({ colorScheme: index === 1 ? 'dark' : 'light' })
    if (index < 2)
      await page.screenshot({
        path: `test-results/editing-${index === 0 ? 'channel-light' : 'direct-dark'}.png`,
        animations: 'disabled',
      })
    await editor.press('Shift+Enter')
    await editor.press('x')
    await editor.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true })
    await expect(editor).toBeVisible()
    if (index === 0) await page.getByRole('button', { name: 'Save', exact: true }).click()
    else await editor.press('Enter')
    await expect(row(page, `Corrected ${index}\nx`)).toBeVisible()
    await expect(row(page, `Corrected ${index}\nx`).locator('.message-edited')).toHaveAttribute(
      'title',
      /^Edited /,
    )
    await expect(row(page, `Corrected ${index}\nx`).locator('.message-edited')).toHaveCSS(
      'font-size',
      '12px',
    )
    await expect(
      row(page, `Corrected ${index}\nx`).getByRole('button', { name: 'Edit message' }),
    ).toBeFocused()
    await expect(composer).toHaveValue('Independent unsent draft')
    await page.emulateMedia({ colorScheme: index === 1 ? 'dark' : 'light' })
    await row(page, `Corrected ${index}\nx`).getByRole('button', { name: 'Edit message' }).click()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  }
  await page.reload()
  await sidebar(page)
    .getByRole('button', { name: /^Edit group/ })
    .click()
  await expect(row(page, 'Corrected 2\nx')).toBeVisible()
})

test('failed and stale edits retain text and stale history and send responses preserve newer revisions', async ({
  page,
}) => {
  const alice = await author(page, 'edit-races')
  const room = Room.parse((await fixture.admin.call('/api/rooms', { name: 'Races' })).value)
  const channel = Channel.parse(
    (await fixture.admin.call('/api/channels', { roomId: room.id, kind: 'text', name: 'races' }))
      .value,
  )
  await page.reload()
  await railTile(page, room.name).click()
  await sidebar(page)
    .getByRole('button', { name: /^races/ })
    .click()
  const sent = hold(page, '**/api/messages')
  const heldSend = await sent
  await page.locator('#message').fill('Original delayed send')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await heldSend.held
  await expect(
    row(page, 'Original delayed send').getByRole('button', { name: 'Edit message' }),
  ).toBeVisible()
  const message = Message.array().parse(
    (await alice.call(`/api/messages?channelId=${channel.id}`)).value,
  )[0]
  if (!message) throw new Error('Missing sent message')
  const heldHistory = await hold(page, '**/api/messages?channelId=*')
  await railTile(page, 'Home').click()
  await railTile(page, room.name).click()
  await heldHistory.held
  const corrected = Message.parse(
    (
      await alice.call('/api/messages/edit', {
        channelId: channel.id,
        messageId: message.id,
        retryId: crypto.randomUUID(),
        expectedRevision: message.revision,
        body: 'Latest correction',
      })
    ).value,
  )
  await expect(row(page, corrected.body)).toBeVisible()
  await heldSend.release()
  await heldHistory.release()
  await expect(row(page, corrected.body)).toBeVisible()
  await expect(row(page, 'Original delayed send')).toHaveCount(0)
  await row(page, corrected.body).getByRole('button', { name: 'Edit message' }).click()
  const editor = page.getByRole('textbox', { name: 'Edit message', exact: true })
  await editor.fill('My retained correction')
  await page.route('**/api/messages/edit', (route) => route.abort(), { times: 1 })
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('form', { name: 'Edit message' }).getByRole('alert')).toBeVisible()
  await expect(editor).toHaveValue('My retained correction')
  const feedback = page.getByRole('form', { name: 'Edit message' }).getByRole('alert')
  await expect(feedback).toHaveText('Couldn’t save your changes. Your edit is still here.')
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    const errorColor = await feedback.evaluate((node) => getComputedStyle(node).color)
    await expect(editor).toHaveCSS('box-shadow', `${errorColor} 0px 0px 0px 1px inset`)
    await page
      .locator('.message-editor')
      .screenshot({ path: `test-results/editing-failed-${theme}.png`, animations: 'disabled' })
  }
  await alice.call('/api/messages/edit', {
    channelId: channel.id,
    messageId: message.id,
    retryId: crypto.randomUUID(),
    expectedRevision: corrected.revision,
    body: 'Other window correction',
  })
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('This message changed')
  await expect(editor).toHaveValue('My retained correction')
  await expect(feedback).toHaveText(
    'This message changed elsewhere. Cancel, then edit the latest version.',
  )
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  await editor.fill('An updated but still stale correction')
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  let resubmitted = false
  await page.route('**/api/messages/edit', async (route) => {
    resubmitted = true
    await route.continue()
  })
  await editor.press('Enter')
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await expect(feedback).toBeVisible()
    await page
      .locator('.message-editor')
      .screenshot({ path: `test-results/editing-conflict-${theme}.png`, animations: 'disabled' })
  }
  expect(resubmitted).toBe(false)
  await page.unroute('**/api/messages/edit')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(row(page, 'Other window correction')).toBeVisible()
  await row(page, 'Other window correction').getByRole('button', { name: 'Edit message' }).click()
  await editor.fill('First saved correction')
  const delayedEdit = await hold(page, '**/api/messages/edit')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await delayedEdit.held
  await expect(editor).toHaveAttribute('readonly')
  await expect(page.getByText('Saving your changes…', { exact: true })).toBeVisible()
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await page.locator('.message-editor').screenshot({
      path: `test-results/editing-saving-${theme}.png`,
      animations: 'disabled',
    })
  }
  const saved = Message.array().parse(
    (await alice.call(`/api/messages?channelId=${channel.id}`)).value,
  )[0]
  if (!saved) throw new Error('Missing correction')
  await alice.call('/api/messages/edit', {
    channelId: channel.id,
    messageId: saved.id,
    retryId: crypto.randomUUID(),
    expectedRevision: saved.revision,
    body: 'Latest after delayed edit response',
  })
  await delayedEdit.release()
  await expect(row(page, 'Latest after delayed edit response')).toBeVisible()
  await expect(row(page, 'First saved correction')).toHaveCount(0)
})

test('group edits to pre-admission history apply and delayed edit responses cannot restore a revoked admission', async ({
  page,
}) => {
  const alice = await author(page, 'edit-admission')
  const bob = await peer('edit-admission-b'),
    cal = await peer('edit-admission-c')
  const group = GroupObservation.parse(
    (
      await alice.call('/api/groups', {
        name: 'Admission edits',
        retryId: crypto.randomUUID(),
        others: [bob.userId, cal.userId],
      })
    ).value,
  ).group
  const aa = access(group, alice.userId),
    ba = access(group, bob.userId)
  const original = GroupMessage.parse(
    (
      await alice.call('/api/group/messages', {
        ...aa,
        retryId: crypto.randomUUID(),
        body: 'History before rejoining',
      })
    ).value,
  )
  await alice.call('/api/group/leave', aa)
  const rejoined = GroupObservation.parse(
    (await bob.call('/api/group/people', { ...ba, userIds: [alice.userId] })).value,
  ).group
  const newAa = access(rejoined, alice.userId)
  await expect(sidebar(page).getByRole('button', { name: /^Admission edits/ })).toBeVisible()
  await sidebar(page)
    .getByRole('button', { name: /^Admission edits/ })
    .click()
  const latest = GroupMessage.parse(
    (
      await alice.call('/api/group/messages/edit', {
        ...newAa,
        messageId: original.id,
        expectedRevision: original.revision,
        retryId: crypto.randomUUID(),
        body: 'Edited old history',
      })
    ).value,
  )
  await expect(row(page, latest.body)).toBeVisible()
  await row(page, latest.body).getByRole('button', { name: 'Edit message' }).click()
  await page
    .getByRole('textbox', { name: 'Edit message', exact: true })
    .fill('Delayed authorized edit')
  const delayed = await hold(page, '**/api/group/messages/edit')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await delayed.held
  await expect(page.getByRole('form', { name: 'Edit message', exact: true })).toHaveAttribute(
    'aria-busy',
    'true',
  )
  await alice.call('/api/group/leave', newAa)
  await expect(sidebar(page).getByRole('button', { name: /^Admission edits/ })).toHaveCount(0)
  await delayed.release()
  await expect(sidebar(page).getByRole('button', { name: /^Admission edits/ })).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText('Delayed authorized edit')
  await expect(page.getByRole('textbox', { name: 'Edit message', exact: true })).toHaveCount(0)
  const snapshot = Snapshot.parse((await bob.call('/api/snapshot')).value)
  expect(snapshot.groups.find((g) => g.id === group.id)?.latest?.body).toBe(
    'Delayed authorized edit',
  )
})

test('direct and group summaries keep newer edits when history and group metadata arrive late', async ({
  page,
}) => {
  const alice = await author(page, 'edit-summaries')
  const room = Room.parse((await fixture.admin.call('/api/rooms', { name: 'Summary room' })).value)
  await fixture.admin.call('/api/channels', { roomId: room.id, kind: 'text', name: 'summary' })
  const bob = await peer('edit-summaries-b'),
    cal = await peer('edit-summaries-c')
  await peer('edit-summaries-d')
  const direct = DirectConversation.parse(
    (await alice.call('/api/direct/conversations', { userId: bob.userId })).value,
  )
  const dm = DirectMessage.parse(
    (
      await alice.call('/api/direct/messages', {
        conversationId: direct.id,
        retryId: crypto.randomUUID(),
        body: 'Original direct summary',
      })
    ).value,
  )
  const group = GroupObservation.parse(
    (
      await alice.call('/api/groups', {
        name: 'Summary edits',
        retryId: crypto.randomUUID(),
        others: [bob.userId, cal.userId],
      })
    ).value,
  ).group
  const aa = access(group, alice.userId)
  const gm = GroupMessage.parse(
    (
      await alice.call('/api/group/messages', {
        ...aa,
        retryId: crypto.randomUUID(),
        body: 'Original group summary',
      })
    ).value,
  )
  await page.reload()
  const directHistory = await hold(page, '**/api/direct/messages?conversationId=*')
  await sidebar(page)
    .getByRole('button', { name: /^edit-summaries-b/ })
    .click()
  await directHistory.held
  await alice.call('/api/direct/messages/edit', {
    conversationId: direct.id,
    messageId: dm.id,
    expectedRevision: dm.revision,
    retryId: crypto.randomUUID(),
    body: 'Latest direct summary',
  })
  await expect(row(page, 'Latest direct summary')).toBeVisible()
  await directHistory.release()
  await expect(row(page, 'Latest direct summary')).toBeVisible()
  await railTile(page, 'Home').click()
  await expect(
    page.getByRole('main').getByRole('button', { name: /edit-summaries-b/ }),
  ).toContainText('Latest direct summary')
  const groupHistory = await hold(page, '**/api/group/messages?groupId=*')
  await sidebar(page)
    .getByRole('button', { name: /^Summary edits/ })
    .click()
  await groupHistory.held
  const first = GroupMessage.parse(
    (
      await alice.call('/api/group/messages/edit', {
        ...aa,
        messageId: gm.id,
        expectedRevision: gm.revision,
        retryId: crypto.randomUUID(),
        body: 'First group correction',
      })
    ).value,
  )
  await expect(row(page, first.body)).toBeVisible()
  await groupHistory.release()
  await expect(row(page, first.body)).toBeVisible()
  await page.getByRole('button', { name: 'Members · 3', exact: true }).click()
  await page
    .getByRole('dialog', { name: group.name, exact: true })
    .getByRole('button', { name: 'Add people', exact: true })
    .click()
  const add = page.getByRole('dialog', { name: 'Add people', exact: true })
  await add.getByRole('checkbox', { name: 'edit-summaries-d', exact: true }).check()
  const metadata = await hold(page, '**/api/group/people')
  await add.getByRole('button', { name: 'Add people', exact: true }).click()
  await metadata.held
  await alice.call('/api/group/messages/edit', {
    ...aa,
    messageId: gm.id,
    expectedRevision: first.revision,
    retryId: crypto.randomUUID(),
    body: 'Latest group summary',
  })
  await metadata.release()
  await expect(page.getByRole('button', { name: 'Members · 4', exact: true })).toBeVisible()
  await railTile(page, 'Home').click()
  await expect(page.getByRole('main').getByRole('button', { name: /Summary edits/ })).toContainText(
    'Latest group summary',
  )
  await page.reload()
  await page.route('**/api/group/messages?groupId=*', (route) => route.fulfill({ json: [gm] }), {
    times: 1,
  })
  await sidebar(page)
    .getByRole('button', { name: /^Summary edits/ })
    .click()
  await expect(row(page, 'Latest group summary')).toBeVisible()
  await expect(row(page, gm.body)).toHaveCount(0)
  await page.route(
    '**/api/direct/messages?conversationId=*',
    (route) => route.fulfill({ json: [dm] }),
    { times: 1 },
  )
  await sidebar(page)
    .getByRole('button', { name: /^edit-summaries-b/ })
    .click()
  await expect(row(page, 'Latest direct summary')).toBeVisible()
  await expect(row(page, dm.body)).toHaveCount(0)
})

test('editing outside the loaded history page keeps the paging boundary and all intervening messages', async ({
  page,
}) => {
  const alice = await author(page, 'edit-pages')
  const room = Room.parse((await fixture.admin.call('/api/rooms', { name: 'Editing pages' })).value)
  const channel = Channel.parse(
    (
      await fixture.admin.call('/api/channels', {
        roomId: room.id,
        kind: 'text',
        name: 'pages',
      })
    ).value,
  )
  const saved: Message[] = []
  for (let index = 0; index < 105; index++)
    saved.push(
      Message.parse(
        (
          await alice.call('/api/messages', {
            channelId: channel.id,
            retryId: crypto.randomUUID(),
            body: `Paging message ${index}`,
          })
        ).value,
      ),
    )
  await page.reload()
  await railTile(page, room.name).click()
  await sidebar(page)
    .getByRole('button', { name: /^pages/ })
    .click()
  await expect(row(page, 'Paging message 104')).toBeVisible()
  await expect(page.locator('.message-body').filter({ hasText: /^Paging message 2$/ })).toHaveCount(
    0,
  )
  const oldest = saved[0]
  if (!oldest) throw new Error('Missing oldest message')
  await alice.call('/api/messages/edit', {
    channelId: channel.id,
    messageId: oldest.id,
    expectedRevision: oldest.revision,
    retryId: crypto.randomUUID(),
    body: 'Oldest corrected outside the page',
  })
  await expect(row(page, 'Oldest corrected outside the page')).toHaveCount(1)
  await page.getByRole('button', { name: 'Load earlier messages', exact: true }).click()
  await expect(page.locator('.message-body').filter({ hasText: /^Paging message 2$/ })).toHaveCount(
    1,
  )
  await expect(row(page, 'Oldest corrected outside the page')).toHaveCount(1)
  await expect(page.locator('article.message')).toHaveCount(105)
})

test('group metadata before a creation event preserves unread and newer message revisions', async ({
  page,
}) => {
  const alice = await author(page, 'edit-unread')
  const bob = await peer('edit-unread-b'),
    cal = await peer('edit-unread-c'),
    dee = await peer('edit-unread-d')
  const id = UserId.parse(alice.userId)
  const group = GroupObservation.parse(
    (
      await alice.call('/api/groups', {
        name: 'Unread edits',
        retryId: crypto.randomUUID(),
        others: [bob.userId, cal.userId],
      })
    ).value,
  ).group
  const thread = groupThread(group, id)
  if (!thread) throw new Error('Missing admission')
  let state = observeGroup(initialGroups([]), group, group.revision, id, group)
  const sent = GroupMessage.parse(
    (
      await bob.call('/api/group/messages', {
        ...access(group, bob.userId),
        retryId: crypto.randomUUID(),
        body: 'Unread group message',
      })
    ).value,
  )
  const metadata = GroupObservation.parse(
    (
      await alice.call('/api/group/people', {
        ...access(group, alice.userId),
        userIds: [dee.userId],
      })
    ).value,
  )
  state = observeGroup(state, metadata.group, metadata.at, id, metadata.group)
  state = groupMessage(state, thread, sent, true, true)
  expect(state.authority.get(group.id)?.current?.group.unread).toBe(1)
  const corrected = GroupMessage.parse(
    (
      await bob.call('/api/group/messages/edit', {
        ...access(group, bob.userId),
        messageId: sent.id,
        expectedRevision: sent.revision,
        retryId: crypto.randomUUID(),
        body: 'Corrected unread group message',
      })
    ).value,
  )
  const snapshot = Snapshot.parse((await alice.call('/api/snapshot')).value)
  const latest = snapshot.groups.find((g) => g.id === group.id)
  if (!latest) throw new Error('Missing group')
  state = observeGroup(state, latest, snapshot.cursor, id, latest)
  expect(state.messages.find((m) => m.id === sent.id)?.body).toBe(corrected.body)
  state = groupMessage(state, thread, sent)
  expect(state.messages.find((m) => m.id === sent.id)?.body).toBe(corrected.body)
  expect(state.authority.get(group.id)?.current?.group.unread).toBe(1)
})

test('retrying synchronization refetches edited history and keeps every history page reachable', async ({
  page,
}) => {
  const alice = await author(page, 'edit-retry-pages')
  const room = Room.parse((await fixture.admin.call('/api/rooms', { name: 'Retry pages' })).value)
  const channel = Channel.parse(
    (
      await fixture.admin.call('/api/channels', {
        roomId: room.id,
        kind: 'text',
        name: 'retry-pages',
      })
    ).value,
  )
  const saved: Message[] = []
  const send = async (start: number, end: number) => {
    for (let index = start; index < end; index++)
      saved.push(
        Message.parse(
          (
            await alice.call('/api/messages', {
              channelId: channel.id,
              retryId: crypto.randomUUID(),
              body: `Retry paging ${index}`,
            })
          ).value,
        ),
      )
  }
  await send(0, 100)
  let blocked = false
  await page.routeWebSocket('**', (socket) => {
    const server = socket.connectToServer()
    server.onMessage((message) => {
      if (!blocked) socket.send(message)
    })
  })
  await page.reload()
  await railTile(page, room.name).click()
  await sidebar(page)
    .getByRole('button', { name: /^retry-pages/ })
    .click()
  await expect(page.locator('article.message')).toHaveCount(100)
  blocked = true
  await send(100, 250)
  const original = saved[0]
  if (!original) throw new Error('Missing oldest message')
  await alice.call('/api/messages/edit', {
    channelId: channel.id,
    messageId: original.id,
    expectedRevision: original.revision,
    retryId: crypto.randomUUID(),
    body: 'Corrected during disconnection',
  })
  await railTile(page, 'Home').click()
  await page.route('**/api/messages?channelId=*', (route) => route.abort(), { times: 1 })
  await railTile(page, room.name).click()
  await expect(page.getByRole('alert')).toContainText('Couldn’t load messages')
  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect(
    page.locator('.message-body').filter({ hasText: /^Retry paging 249$/ }),
  ).toBeVisible()
  blocked = false
  await page.getByRole('button', { name: 'Load earlier messages', exact: true }).click()
  await expect(page.locator('.message-body').filter({ hasText: /^Retry paging 125$/ })).toHaveCount(
    1,
  )
  await page.getByRole('button', { name: 'Load earlier messages', exact: true }).click()
  await expect(page.locator('article.message')).toHaveCount(250)
  await expect(row(page, 'Corrected during disconnection')).toHaveCount(1)
  await expect(page.locator('.message-body').filter({ hasText: /^Retry paging 0$/ })).toHaveCount(0)
})
