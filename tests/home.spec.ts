import { expect, test, type Page } from '@playwright/test'
import { inviteCode, join, onboard, railTile } from './accounts'
import { useScratchServer } from './server'

useScratchServer('ui')
async function shareInvite(page: Page) {
  await page.getByRole('button', { name: 'Share invite', exact: true }).first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('button', { name: 'Copy invite' })).toBeVisible()
  const code = await inviteCode(page)
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  return code
}

test('room activity sits on the rail and Home holds direct messages', async ({ browser, page }) => {
  const colleague = await browser.newContext()
  const second = await colleague.newPage()
  try {
    await onboard(page, 'avery', 'Harbor home')
    await page.clock.setFixedTime(new Date('2026-10-09T09:30:00'))
    await expect(
      page.getByText('A few steps and your friends have a place to talk.', { exact: true }),
    ).toBeVisible()
    await expect(
      page.getByRole('heading', { name: 'Your server is ready', level: 1 }),
    ).toBeVisible()
    const setup = page.getByRole('region', { name: 'Set up Harbor home' })
    const home = page.getByRole('navigation', { name: 'Harbor home', exact: true })
    await expect(setup).toContainText('0 of 3 done')
    await expect(setup.getByRole('button', { name: 'Add channel' })).toBeDisabled()
    await expect(setup.getByRole('listitem').nth(1)).toContainText(
      'Channels hold the conversation. Create a room first.',
    )
    await expect(setup.getByRole('button', { name: 'Create room' })).toHaveClass(/primary/)
    await page.getByRole('button', { name: 'Member list', exact: true }).click()
    await expect(page.getByRole('list', { name: 'Members' })).toHaveText('Admins · 1avery · You')
    await setup.getByRole('button', { name: 'Create room' }).click()
    await page.getByLabel('Room name').fill('Development')
    await page.getByRole('dialog').getByRole('button', { name: 'Create room' }).click()
    await page.getByRole('button', { name: 'Create a channel', exact: true }).click()
    await page.getByLabel('Channel name').fill('code-review')
    await page.getByRole('dialog').getByRole('button', { name: 'Create channel' }).click()
    await expect(page.getByRole('heading', { name: 'Welcome to #code-review' })).toBeVisible()
    await railTile(page, 'Home').click()
    await expect(setup).toContainText('2 of 3 done')
    await expect(setup.getByRole('listitem')).toHaveText([
      /^Create your first roomDevelopmentDone$/,
      /^Add a channel#code-review in DevelopmentDone$/,
      /^3Share HuddleFriends need access to this machine in Tailscale\.Share invite$/,
    ])
    await expect(setup.getByRole('button', { name: 'Share invite' })).toHaveClass(/primary/)
    const code = await shareInvite(page)

    await railTile(page, 'Development').click()
    await page.getByRole('button', { name: 'Create text channel', exact: true }).click()
    await page.getByLabel('Channel name').fill('zeta-notes')
    await page.getByRole('dialog').getByRole('button', { name: 'Create channel' }).click()
    await expect(page.getByRole('heading', { name: 'Welcome to #zeta-notes' })).toBeVisible()
    await railTile(page, 'Home').click()

    await join(second, 'jonas', code)
    await railTile(second, 'Development').click()
    const composer = second.getByRole('textbox', { name: 'Message #code-review' })
    await composer.fill('@avery please review')
    await second.getByRole('button', { name: 'Send message' }).click()
    await composer.fill('PR 482 is ready for a second review')
    await second.getByRole('button', { name: 'Send message' }).click()
    await expect(second.getByText('PR 482 is ready for a second review')).toBeVisible()

    await expect(setup).toHaveCount(0)
    await expect(page.getByText('Friday, October 9', { exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Good morning, avery.' })).toBeVisible()

    const roomTile = railTile(page, 'Development')
    const badge = roomTile.locator('.rail-count')
    const pill = roomTile.locator('..').locator('.rail-pill')
    await expect(roomTile).toHaveAccessibleDescription('2 unread, 1 mention')
    await expect(badge).toHaveText('1')
    await expect(pill).toHaveCSS('height', '8px')
    await expect(railTile(page, 'Home')).toHaveAccessibleDescription('')
    await expect(railTile(page, 'Home').locator('.rail-count')).toHaveCount(0)
    await expect(home).toHaveText('HomeMembersDirect messagesNo messages yet.')
    const main = page.getByRole('main')
    await expect(main.getByRole('heading', { name: 'No messages yet' })).toBeVisible()
    await expect(main.getByRole('button', { name: 'New message', exact: true })).toHaveClass(
      /header-pill/,
    )
    await expect(main).not.toContainText('PR 482')
    await expect(page.getByRole('tab')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Mark all as read' })).toHaveCount(0)

    await roomTile.click()
    await expect(page.getByRole('heading', { name: 'Welcome to #zeta-notes' })).toBeVisible()
    const channels = page.getByRole('navigation', { name: 'Development channels', exact: true })
    const row = channels.getByRole('button', { name: /^code-review/ })
    await expect(row).toHaveAccessibleName('code-review 1 mention unread')
    await expect(row.locator('.nav-count')).toHaveText(/^1/)
    await railTile(page, 'Home').click()

    await page.reload()
    await expect(roomTile).toHaveAccessibleDescription('2 unread, 1 mention')
    await expect(badge).toHaveText('1')

    await roomTile.click()
    await expect(page.getByRole('heading', { name: 'Welcome to #code-review' })).toBeVisible()
    await expect(page.getByText('PR 482 is ready for a second review')).toBeVisible()
    await expect(channels.getByRole('button', { name: 'code-review', exact: true })).toBeVisible()
    await expect(row.locator('.nav-count')).toHaveCount(0)
    await expect(roomTile).toHaveAccessibleDescription('')
    await expect(badge).toHaveCount(0)
    await railTile(page, 'Home').click()
    await expect(pill).toHaveCSS('height', '0px')

    await composer.fill('Standup moved to 10')
    await second.getByRole('button', { name: 'Send message' }).click()
    await expect(roomTile).toHaveAccessibleDescription('1 unread')
    await expect(badge).toHaveCount(0)
    await page.reload()
    await expect(roomTile).toHaveAccessibleDescription('1 unread')

    await railTile(second, 'Home').click()
    await second.getByRole('button', { name: 'Member list', exact: true }).click()
    await second
      .getByRole('list', { name: 'Members' })
      .getByRole('button', { name: 'View avery', exact: true })
      .click()
    await second
      .getByRole('dialog', { name: 'avery', exact: true })
      .getByRole('button', { name: 'Message avery', exact: true })
      .click()
    await second
      .getByRole('textbox', { name: 'Message @avery', exact: true })
      .fill('Coffee after standup?')
    await second.getByRole('button', { name: 'Send message' }).click()
    await expect(railTile(page, 'Home')).toHaveAccessibleDescription('1 unread')
    await expect(railTile(page, 'Home').locator('.rail-count')).toHaveText('1')
    await expect(main.getByRole('heading', { name: 'Direct messages' })).toBeVisible()
    const direct = main.getByRole('button', { name: /^jonas/ })
    await expect(direct).toContainText('Coffee after standup?')
    await expect(direct).toContainText('1 new')
    await direct.click()
    await expect(
      page.getByRole('heading', { level: 1, name: 'Conversation with jonas', exact: true }),
    ).toBeVisible()
    await expect(railTile(page, 'Home')).toHaveAccessibleDescription('')
    await expect(roomTile).toHaveAccessibleDescription('1 unread')
  } finally {
    await colleague.close()
  }
})
