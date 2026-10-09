import { expect, test, type Page } from '@playwright/test'
import { join, onboard, syntheticEmail } from './passwordless'
import { useScratchServer } from './server'

useScratchServer('ui')
async function inviteCoworker(page: Page) {
  const email = syntheticEmail()
  await page.getByRole('button', { name: 'Invite coworkers', exact: true }).click()
  await page.getByLabel('Work email').fill(email)
  await page.getByRole('dialog').getByRole('button', { name: 'Send invitation' }).click()
  await expect(page.getByRole('heading', { name: 'Invitation sent' })).toBeVisible()
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  return email
}

test('home gathers mentions and unread channels, and reading clears them', async ({
  browser,
  page,
}) => {
  const colleague = await browser.newContext()
  const second = await colleague.newPage()
  try {
    await onboard(page, 'Avery Owner', 'Harbor home')
    await page.clock.setFixedTime(new Date('2026-10-09T09:30:00'))
    await expect(page.getByText('Friday, October 9', { exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Good morning, Avery' })).toBeVisible()
    await page
      .getByRole('region', { name: 'Set up Harbor home' })
      .getByRole('button', { name: 'Create room' })
      .click()
    await page.getByLabel('Room name').fill('Development')
    await page.getByRole('dialog').getByRole('button', { name: 'Create room' }).click()
    await page.getByRole('button', { name: 'Create a channel', exact: true }).click()
    await page.getByLabel('Channel name').fill('code-review')
    await page.getByRole('dialog').getByRole('button', { name: 'Create channel' }).click()
    await expect(page.getByRole('heading', { name: 'Welcome to #code-review' })).toBeVisible()
    await page.getByRole('button', { name: 'Home', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'You’re all caught up' })).toBeVisible()
    const invited = await inviteCoworker(page)

    await join(second, invited, 'Jonas Colleague')
    await second.getByRole('button', { name: 'Development', exact: true }).click()
    const composer = second.getByRole('textbox', { name: 'Message #code-review' })
    await composer.fill('@Avery please review')
    await second.getByRole('button', { name: 'Send message' }).click()
    await composer.fill('PR 482 is ready for a second review')
    await second.getByRole('button', { name: 'Send message' }).click()
    await expect(second.getByText('PR 482 is ready for a second review')).toBeVisible()

    await expect(page.getByRole('tab', { name: 'All 2' })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Mentions 1' })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Messages 1' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Home 2', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Development 2', exact: true })).toBeVisible()
    const mention = page.getByRole('button', { name: /@Avery please review/ })
    await expect(mention).toContainText('Jonas Colleague')
    await expect(mention).toContainText('Development › #code-review')
    await expect(mention).toContainText('Mention')
    await expect(mention.locator('.mention')).toHaveText('@Avery')
    const channel = page.getByRole('button', { name: /^#code-review/ })
    await expect(channel).toContainText('Development · 2 new messages')
    await expect(channel).toContainText('Jonas Colleague: PR 482 is ready for a second review')
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
    await expect(next).toContainText('Jonas Colleague: Standup moved to 10')
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
