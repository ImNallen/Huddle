import { expect, test, type Page } from '@playwright/test'
import { inviteCode, join, onboard } from './passwordless'
import { useScratchServer } from './server'

useScratchServer('ui')
async function shareInvite(page: Page) {
  await page.getByRole('button', { name: 'Share invite', exact: true }).first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('button', { name: 'Copy invite' }).first()).toBeVisible()
  await expect(dialog).not.toContainText('huddle:')
  const code = await inviteCode(page)
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  return code
}

test('home gathers mentions and unread channels, and reading clears them', async ({
  browser,
  page,
}) => {
  const colleague = await browser.newContext()
  const second = await colleague.newPage()
  try {
    await onboard(page, 'avery', 'Harbor home')
    await page.clock.setFixedTime(new Date('2026-10-09T09:30:00'))
    await expect(page.getByText('Welcome, avery', { exact: true })).toBeVisible()
    await expect(
      page.getByRole('heading', { name: 'Your server is ready', level: 1 }),
    ).toBeVisible()
    const setup = page.getByRole('region', { name: 'Set up Harbor home' })
    await expect(setup).toContainText('0 of 3 done')
    await expect(setup.getByRole('button', { name: 'Add channel' })).toBeDisabled()
    await expect(setup.getByRole('listitem').nth(1)).toContainText(
      'Channels are where a room’s conversations happen. Create a room first.',
    )
    await expect(setup.getByRole('button', { name: 'Create room' })).toHaveClass(/primary/)
    await expect(page.getByText('Only you so far.', { exact: true })).toBeVisible()
    await setup.getByRole('button', { name: 'Create room' }).click()
    await page.getByLabel('Room name').fill('Development')
    await page.getByRole('dialog').getByRole('button', { name: 'Create room' }).click()
    await page.getByRole('button', { name: 'Create a channel', exact: true }).click()
    await page.getByLabel('Channel name').fill('code-review')
    await page.getByRole('dialog').getByRole('button', { name: 'Create channel' }).click()
    await expect(page.getByRole('heading', { name: 'Welcome to #code-review' })).toBeVisible()
    await page.getByRole('button', { name: 'Home', exact: true }).click()
    await expect(setup).toContainText('2 of 3 done')
    await expect(setup.getByRole('listitem')).toHaveText([
      /^Create your first roomDevelopmentDone$/,
      /^Add a channel#code-review in DevelopmentDone$/,
      /^3Share HuddleCopy an invite\. A friend pastes it into Huddle and creates a username\.Share invite$/,
    ])
    await expect(setup.getByRole('button', { name: 'Share invite' })).toHaveClass(/primary/)
    const code = await shareInvite(page)

    await join(second, 'jonas', code)
    await second.getByRole('button', { name: 'Development', exact: true }).click()
    const composer = second.getByRole('textbox', { name: 'Message #code-review' })
    await composer.fill('@avery please review')
    await second.getByRole('button', { name: 'Send message' }).click()
    await composer.fill('PR 482 is ready for a second review')
    await second.getByRole('button', { name: 'Send message' }).click()
    await expect(second.getByText('PR 482 is ready for a second review')).toBeVisible()

    await expect(setup).toHaveCount(0)
    await expect(page.getByText('Friday, October 9', { exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Good morning, avery' })).toBeVisible()

    await expect(page.getByRole('tab', { name: 'All 2' })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Mentions 1' })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Messages 1' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Home 2', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Development 2', exact: true })).toBeVisible()
    const mention = page.getByRole('button', { name: /@avery please review/ })
    await expect(mention).toContainText('jonas')
    await expect(mention).toContainText('Development › #code-review')
    await expect(mention).toContainText('Mention')
    await expect(mention.locator('.mention')).toHaveText('@avery')
    const channel = page.getByRole('button', { name: /^#code-review/ })
    await expect(channel).toContainText('Development · 2 new messages')
    await expect(channel).toContainText('jonas: PR 482 is ready for a second review')
    await expect(channel).toContainText('2 new')
    await page.getByRole('tab', { name: 'Mentions 1' }).click()
    await expect(channel).toHaveCount(0)
    await expect(mention).toBeVisible()

    await mention.click()
    await expect(page.getByRole('heading', { name: 'Welcome to #code-review' })).toBeVisible()
    await expect(page.getByText('PR 482 is ready for a second review')).toBeVisible()
    await expect(page.getByRole('button', { name: 'code-review', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Home', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'You’re all caught up' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Development', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Home', exact: true })).toBeVisible()

    await composer.fill('Standup moved to 10')
    await second.getByRole('button', { name: 'Send message' }).click()
    const next = page.getByRole('button', { name: /^#code-review/ })
    await expect(next).toContainText('1 new')
    await expect(next).toContainText('jonas: Standup moved to 10')
    await expect(page.getByRole('button', { name: 'Development 1', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Mark all as read' }).click()
    await expect(page.getByRole('heading', { name: 'You’re all caught up' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Development', exact: true })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('heading', { name: 'You’re all caught up' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Development', exact: true })).toBeVisible()
  } finally {
    await colleague.close()
  }
})
