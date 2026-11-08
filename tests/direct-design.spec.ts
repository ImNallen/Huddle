import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import {
  Channel,
  DirectConversation,
  DirectMessage,
  Room,
  ServerInvite,
  parseInvite,
} from '../packages/contracts/src/index'
import { Client } from '../apps/server/scripts/harness'
import { actAs, browserApp, expectHome, railTile, serverURL } from './accounts'
import { useScratchServer } from './server'

const server = useScratchServer('api')

test('direct conversations and the searchable person picker match both themes and keep drafts private', async ({
  page,
}) => {
  const admin = server.admin
  await admin.act({
    kind: 'profile.save',
    profile: { name: 'Adam Nilsson', avatar: { kind: 'mascot', shape: 'circle', color: 'teal' } },
  })
  const room = Room.parse((await admin.call('/api/rooms', { name: 'The studio' })).value)
  Channel.parse(
    (await admin.call('/api/channels', { roomId: room.id, name: 'general', kind: 'text' })).value,
  )
  const code = parseInvite(ServerInvite.parse((await admin.call('/api/invite')).value).invite).code
  const people = []
  for (const [login, name, color] of [
    ['maya', 'Maya Lind', 'rose'],
    ['jonas', 'Jonas Berg', 'indigo'],
    ['leah', 'Leah Chen', 'sky'],
    ['nora', 'Nora West', 'violet'],
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
  if (!maya || !jonas || !leah || !admin.userId)
    throw new Error('The conversation needs its members.')
  const direct = async (client: Client) =>
    DirectConversation.parse(
      (await client.call('/api/direct/conversations', { userId: admin.userId })).value,
    )
  const mayaDirect = await direct(maya)
  const post = async (client: Client, conversationId: DirectConversation['id'], body: string) =>
    DirectMessage.parse(
      (await client.call('/api/direct/messages', { retryId: randomUUID(), conversationId, body }))
        .value,
    )
  const jonasDirect = await direct(jonas)
  await post(jonas, jonasDirect.id, 'Found the perfect spot for Saturday.')
  const leahDirect = await direct(leah)
  const leahMessage = await post(leah, leahDirect.id, 'See you in the lounge later.')
  await admin.call('/api/direct/read', {
    conversationId: leahDirect.id,
    cursor: leahMessage.cursor,
  })

  for (const [client, body] of [
    [maya, 'Morning! How’s your day going so far?'],
    [admin, 'Pretty slow, in the best way. Just making some coffee.'],
    [maya, 'That sounds like the right kind of morning.'],
    [
      admin,
      'I have a few things to work on this afternoon.\nWould be nice to have a bit of company.',
    ],
    [maya, 'Are you around for a little co-working?'],
  ] as const)
    await post(client, mayaDirect.id, body)

  await actAs(page, 'uiadmin')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.goto(browserApp)
  await expectHome(page)
  const sidebar = page.getByRole('navigation', { name: 'Huddle UI', exact: true })
  await sidebar.getByRole('button', { name: 'New message', exact: true }).click()
  const picker = page.getByRole('dialog', { name: 'New message', exact: true })
  const search = picker.getByRole('combobox', { name: 'Find a person', exact: true })
  const options = picker.getByRole('option')
  await expect(options).toHaveCount(4)
  await expect(options.filter({ hasText: 'Adam Nilsson' })).toHaveCount(0)
  await expect(search).toBeFocused()
  await picker.getByRole('heading', { name: 'New message', exact: true }).click()
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await page.evaluate(() => document.fonts.ready)
    const path = test.info().outputPath(`new-message-${colorScheme}.png`)
    await picker.screenshot({ path })
    await test.info().attach(`new-message-${colorScheme}`, { path, contentType: 'image/png' })
  }
  await search.fill('no matching person')
  await expect(options).toHaveCount(0)
  await expect(picker.getByRole('status')).toHaveText('No people found. Try another name.')
  await search.fill('')
  const first = await options.first().getAttribute('id')
  const second = await options.nth(1).getAttribute('id')
  await search.press('ArrowDown')
  await expect(search).toHaveAttribute('aria-activedescendant', second ?? '')
  await search.press('ArrowUp')
  await expect(search).toHaveAttribute('aria-activedescendant', first ?? '')
  await search.fill('mAyA')
  await expect(options).toHaveCount(1)
  await expect(options.first()).toHaveText('Maya Lind')
  await search.press('Enter')
  await expect(picker).toHaveCount(0)

  const main = page.getByRole('main')
  const composer = main.getByRole('textbox', { name: 'Message @Maya Lind', exact: true })
  await expect(
    main.getByRole('heading', { name: 'Conversation with Maya Lind', exact: true }),
  ).toBeVisible()
  await expect(main.getByText('Just the two of you.', { exact: true })).toBeVisible()
  await expect(main.locator('.direct-person')).toHaveText('Maya LindDirect message')
  await expect(main.locator('.direct-topbar .avatar-slot > span')).toHaveJSProperty(
    'offsetWidth',
    32,
  )
  await expect(main.getByRole('article')).toHaveCount(5)
  await expect(composer).toHaveAttribute('placeholder', 'Message Maya')
  await expect(sidebar.getByRole('button', { name: /^Maya Lind/ })).toHaveAttribute(
    'aria-current',
    'page',
  )
  await expect(
    sidebar.getByRole('button', { name: /^Maya Lind/ }).locator('.direct-count'),
  ).toHaveCount(0)
  await main.getByRole('heading', { name: 'Conversation with Maya Lind', exact: true }).click()
  await page.mouse.move(1400, 880)
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await page.evaluate(() => document.fonts.ready)
    const path = test.info().outputPath(`direct-${colorScheme}.png`)
    await page.screenshot({ path })
    await test.info().attach(`direct-${colorScheme}`, { path, contentType: 'image/png' })
  }
  await composer.fill('A draft for Maya')
  const details = main.getByRole('button', { name: 'Conversation details', exact: true })
  await details.click()
  await expect(
    main.getByRole('region', { name: 'Conversation details', exact: true }),
  ).toContainText('Messages are stored on this server unencrypted, so its host could read them.')
  await page.keyboard.press('Escape')
  await expect(details).toBeFocused()
  await expect(composer).toHaveValue('A draft for Maya')

  await sidebar.getByRole('button', { name: 'New message', exact: true }).click()
  await post(maya, mayaDirect.id, 'Arrived while the picker was open.')
  await expect(
    sidebar.getByRole('button', { name: /^Maya Lind/ }).locator('.direct-count'),
  ).toHaveText('1 unread')
  await picker.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(composer).toHaveValue('A draft for Maya')
  await expect(main.getByRole('article').last()).toContainText('Arrived while the picker was open.')
  await expect(
    sidebar.getByRole('button', { name: /^Maya Lind/ }).locator('.direct-count'),
  ).toHaveCount(0)

  await sidebar.getByRole('button', { name: 'New message', exact: true }).click()
  await search.fill('Nora')
  let rejectOpen = () => {}
  const opening = new Promise<void>((resolve) => {
    rejectOpen = resolve
  })
  await page.route('**/api/direct/conversations', async (route) => {
    await opening
    await route.abort('connectionfailed')
  })
  await search.press('Enter')
  await expect(search).toBeDisabled()
  await expect(picker.getByRole('status')).toHaveText('Opening conversation…')
  rejectOpen()
  await expect(picker.getByRole('alert')).toBeVisible()
  await expect(search).toBeEnabled()
  await expect(search).toBeFocused()
  await expect(search).toHaveValue('Nora')
  await page.unroute('**/api/direct/conversations')
  await search.press('Enter')
  await expect(picker).toHaveCount(0)
  await expect(
    main.getByRole('heading', { name: 'Conversation with Nora West', exact: true }),
  ).toBeVisible()
  await expect(main.getByRole('article')).toHaveCount(0)
  const noraComposer = main.getByRole('textbox', { name: 'Message @Nora West', exact: true })
  await noraComposer.fill('A first hello for Nora')
  await main.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(main.getByRole('article').last()).toContainText('A first hello for Nora')
  await sidebar.getByRole('button', { name: /^Maya Lind/ }).click()
  await expect(composer).toHaveValue('A draft for Maya')
  await page.setViewportSize({ width: 640, height: 480 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(640)
  await composer.fill('Still room for a direct message')
  await main.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(main.getByRole('article').last()).toContainText('Still room for a direct message')
  await railTile(page, 'Home').click()
  await expectHome(page)
})
