import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { Channel, Room, ServerInvite, parseInvite } from '../packages/contracts/src/index'
import { Client } from '../apps/server/scripts/harness'
import { actAs, browserApp, expectHome, railTile, serverURL } from './accounts'
import { useScratchServer } from './server'

const server = useScratchServer('api')

test('the room layout supports both themes, focused navigation, and composer actions', async ({
  page,
}) => {
  await server.admin.act({
    kind: 'profile.save',
    profile: { name: 'Adam Nilsson', avatar: { kind: 'mascot', shape: 'circle', color: 'teal' } },
  })
  const room = Room.parse((await server.admin.call('/api/rooms', { name: 'The studio' })).value)
  const channels: Channel[] = []
  for (const name of ['general', 'design', 'good-finds', 'off-topic']) {
    channels.push(
      Channel.parse(
        (await server.admin.call('/api/channels', { roomId: room.id, name, kind: 'text' })).value,
      ),
    )
  }
  for (const name of ['the-lounge', 'quiet-corner']) {
    await server.admin.call('/api/channels', { roomId: room.id, name, kind: 'voice' })
  }
  const channel = channels[0]
  if (!channel) throw new Error('The room needs a general channel.')
  const invite = ServerInvite.parse((await server.admin.call('/api/invite')).value)
  const code = parseInvite(invite.invite).code
  const people = []
  for (const [login, name] of [
    ['maya', 'Maya Lind'],
    ['jonas', 'Jonas Berg'],
    ['leah', 'Leah Chen'],
  ] as const) {
    const client = new Client(serverURL, `${login}@huddle.test`)
    await client.act({ kind: 'account.join', code, name })
    people.push(client)
  }
  const [maya, jonas, leah] = people
  if (!maya || !jonas || !leah) throw new Error('The conversation needs its participants.')
  for (const [client, body] of [
    [
      maya,
      'Morning everyone. Taking the slow route today.\nAnyone up for a little co-working later?',
    ],
    [jonas, 'I’m in. I’ll be in the lounge after lunch.'],
    [server.admin, 'Sounds good. No agenda, just a bit of company.'],
    [leah, 'Exactly what I needed today. See you there.'],
    [maya, 'Already here with Jonas if anyone wants to drop in.'],
  ] as const) {
    await client.call('/api/messages', { retryId: randomUUID(), channelId: channel.id, body })
  }

  await page.setViewportSize({ width: 1440, height: 900 })
  await actAs(page, 'uiadmin')
  await page.goto(browserApp)
  await expectHome(page)
  await railTile(page, 'The studio').click()
  const navigation = page.getByRole('navigation', { name: 'The studio channels', exact: true })
  await navigation.getByRole('button', { name: /^general\b/ }).click()
  await expect(page.getByRole('article')).toHaveCount(5)
  await expect(page.getByRole('list', { name: 'Members', exact: true })).toHaveCount(0)
  await expect(page.locator('.rail .huddle-logo')).not.toHaveCSS('mask-image', 'none')
  await expect(
    navigation.getByRole('button', { name: /Home|Direct Messages|Members/ }),
  ).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Share invite', exact: true })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Member list', exact: true })).toContainText(
    'Members · 4',
  )

  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
    await page.evaluate(() => document.fonts.ready)
    await expect(page.locator('.main')).toHaveCSS(
      'background-color',
      colorScheme === 'light' ? 'rgb(252, 252, 252)' : 'rgb(22, 22, 22)',
    )
    const path = test.info().outputPath(`room-${colorScheme}.png`)
    await page.screenshot({ path })
    await test.info().attach(`room-${colorScheme}`, {
      path,
      contentType: 'image/png',
    })
  }

  const composer = page.getByRole('textbox', { name: 'Message #general' })
  await composer.fill('Hello ')
  await page.getByRole('button', { name: 'Add mention', exact: true }).click()
  await expect(composer).toHaveValue('Hello @')
  await expect(composer).toBeFocused()
  await composer.fill('A little celebration ')
  await page.getByRole('button', { name: 'Add emoji', exact: true }).click()
  await page.getByRole('button', { name: 'Insert 🎉', exact: true }).click()
  await expect(composer).toHaveValue('A little celebration 🎉')
  await expect(composer).toBeFocused()
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByRole('article').last()).toContainText('A little celebration 🎉')
  await expect(composer).toHaveValue('')

  await page.getByRole('button', { name: 'Share invite', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Copy invite' })).toBeVisible()
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await page.getByRole('button', { name: 'Channel options', exact: true }).click()
  await page.locator('#channel-menu').getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')

  await page.setViewportSize({ width: 640, height: 480 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(640)
  await composer.fill('Still room to chat')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByRole('article').last()).toContainText('Still room to chat')
})
