import { expect, test, type Page } from '@playwright/test'
import { inviteCode, join, onboard, rail, railTile } from './accounts'
import { useScratchServer } from './server'

useScratchServer('ui', { LIVEKIT_API_SECRET: '' })

async function createRoom(page: Page, name: string) {
  await railTile(page, 'Create room').click()
  await page.getByLabel('Room name').fill(name)
  await page.getByRole('dialog').getByRole('button', { name: 'Create room' }).click()
  await expect(page.getByRole('button', { name: `${name} menu`, exact: true })).toBeVisible()
}
async function createTextChannel(page: Page, name: string) {
  await page.getByRole('button', { name: 'Create text channel', exact: true }).click()
  await page.getByLabel('Channel name').fill(name)
  await page.getByRole('dialog').getByRole('button', { name: 'Create channel' }).click()
  await expect(page.getByRole('heading', { name: `Welcome to #${name}` })).toBeVisible()
}
const channelList = (page: Page, room: string) =>
  page.getByRole('navigation', { name: `${room} channels`, exact: true })
const voiceNotice = 'Voice is turned off on this server. Text channels work as usual.'

test('rooms hold their own channels, remember one, and voice channels say when a server has voice off', async ({
  browser,
  page,
}) => {
  const friend = await browser.newContext()
  const member = await friend.newPage()
  try {
    await onboard(page, 'roomadmin', 'Friends Server')
    await expect(page.getByRole('button', { name: 'Friends Server menu' })).toBeVisible()

    await createRoom(page, 'Gaming')
    await expect(railTile(page, 'Gaming')).toHaveAttribute('aria-current', 'true')
    await expect(page.getByRole('heading', { name: 'Gaming has no channels yet' })).toBeVisible()
    await createTextChannel(page, 'general')
    await createTextChannel(page, 'strategy')

    await createRoom(page, 'Design')
    await page.getByRole('button', { name: 'Create text channel', exact: true }).click()
    await expect(page.getByRole('radio', { name: 'Text', exact: true })).toBeChecked()
    await page.getByLabel('Channel name').fill('general')
    await page.getByRole('dialog').getByRole('button', { name: 'Create channel' }).click()
    await expect(page.getByRole('heading', { name: 'Welcome to #general' })).toBeVisible()
    await createTextChannel(page, 'critique')

    await expect(channelList(page, 'Design')).toHaveText(
      'Text channelscritiquegeneralVoice channels',
    )
    await railTile(page, 'Gaming').click()
    await expect(railTile(page, 'Gaming')).toHaveAttribute('aria-current', 'true')
    await expect(railTile(page, 'Design')).not.toHaveAttribute('aria-current', 'true')
    await expect(page.getByRole('button', { name: 'Gaming menu', exact: true })).toBeVisible()
    await expect(channelList(page, 'Gaming')).toHaveText(
      'Text channelsgeneralstrategyVoice channels',
    )

    await expect(page.getByRole('heading', { name: 'Welcome to #strategy' })).toBeVisible()
    await channelList(page, 'Gaming').getByRole('button', { name: 'general' }).click()
    await railTile(page, 'Design').click()
    await expect(page.getByRole('heading', { name: 'Welcome to #critique' })).toBeVisible()
    await railTile(page, 'Gaming').click()
    await expect(page.getByRole('heading', { name: 'Welcome to #general' })).toBeVisible()
    await channelList(page, 'Gaming').getByRole('button', { name: 'strategy' }).click()
    await page.reload()
    await railTile(page, 'Gaming').click()
    await expect(page.getByRole('heading', { name: 'Welcome to #general' })).toBeVisible()

    const requests: string[] = []
    page.on('request', (request) => requests.push(request.url()))
    await page.getByRole('button', { name: 'Create voice channel', exact: true }).click()
    await expect(page.getByRole('radio', { name: 'Voice', exact: true })).toBeChecked()
    await expect(page.getByRole('radio', { name: 'Text', exact: true })).not.toBeChecked()
    await page.getByLabel('Channel name').fill('hangout')
    await page.getByRole('dialog').getByRole('button', { name: 'Create channel' }).click()
    await expect(channelList(page, 'Gaming')).toHaveText(
      'Text channelsgeneralstrategyVoice channelshangout',
    )
    const main = page.getByRole('main')
    await expect(main.getByRole('heading', { name: 'hangout', exact: true })).toBeVisible()
    await expect(main.getByText(voiceNotice, { exact: true })).toBeVisible()
    await expect(page.getByRole('textbox')).toHaveCount(0)
    await expect(main.getByRole('button')).toHaveCount(1)
    await expect(main.getByRole('button', { name: 'Member list', exact: true })).toBeVisible()
    expect(requests.filter((url) => url.includes('/api/messages'))).toEqual([])

    await railTile(page, 'Home').click()
    await railTile(page, 'Gaming').click()
    await expect(main.getByText(voiceNotice, { exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'Create text channel', exact: true }).click()
    await page.getByRole('radio', { name: 'Voice', exact: true }).check()
    await page.getByLabel('Channel name').fill('general')
    await page.getByRole('dialog').getByRole('button', { name: 'Create channel' }).click()
    await expect(page.getByRole('dialog').getByRole('alert')).toHaveText(
      'That name is already in use.',
    )
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
    await channelList(page, 'Gaming').getByRole('button', { name: 'general' }).click()
    await expect
      .poll(() => requests.filter((url) => url.includes('/api/messages')).length)
      .toBeGreaterThan(0)

    await createRoom(page, 'Book Club')
    await railTile(page, 'Home').click()
    await page.getByRole('button', { name: 'Share invite', exact: true }).first().click()
    const code = await inviteCode(page)
    await page.getByRole('button', { name: 'Done', exact: true }).click()

    await join(member, 'bookworm', code)
    await expect(rail(member).getByRole('button', { name: 'Create room' })).toHaveCount(0)
    await railTile(member, 'Book Club').click()
    await expect(
      member.getByRole('heading', { name: 'Book Club has no channels yet' }),
    ).toBeVisible()
    await expect(member.getByText('An admin can create the first channel.')).toBeVisible()
    await expect(channelList(member, 'Book Club')).toHaveText('No channels yet.')
    await railTile(member, 'Gaming').click()
    await expect(member.getByRole('heading', { name: 'Welcome to #general' })).toBeVisible()
    await expect(channelList(member, 'Gaming')).toHaveText(
      'Text channelsgeneralstrategyVoice channelshangout',
    )
    await channelList(member, 'Gaming').getByRole('button', { name: 'hangout' }).click()
    await expect(member.getByText(voiceNotice, { exact: true })).toBeVisible()
    await expect(member.getByRole('textbox')).toHaveCount(0)

    await railTile(member, 'Book Club').click()
    await expect(
      member.getByRole('heading', { name: 'Book Club has no channels yet' }),
    ).toBeVisible()
    await railTile(page, 'Book Club').click()
    await expect(page.getByRole('heading', { name: 'Book Club has no channels yet' })).toBeVisible()
    await page.getByRole('button', { name: 'Create text channel', exact: true }).click()
    await page.getByLabel('Channel name').fill('reading-list')
    await page.getByRole('dialog').getByRole('button', { name: 'Create channel' }).click()
    await expect(member.getByRole('heading', { name: 'Welcome to #reading-list' })).toBeVisible()
  } finally {
    await friend.close()
  }
})
