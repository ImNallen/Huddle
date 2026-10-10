import { expect, test } from '@playwright/test'
import { join, onboard, syntheticEmail } from './passwordless'
import { useScratchServer } from './server'

useScratchServer('ui')

test('an invited colleague joins the server, sends, reconnects, and signs out', async ({
  browser,
  page,
}) => {
  const colleague = await browser.newContext()
  const second = await colleague.newPage()
  try {
    await onboard(page, 'UI owner', 'UI studio')
    await expect(page.getByRole('heading', { name: 'Set up UI studio' })).toBeVisible()
    await page
      .getByRole('region', { name: 'Set up UI studio' })
      .getByRole('button', { name: 'Create room' })
      .click()
    await page.getByLabel('Room name').fill('Design')
    await page.getByRole('dialog').getByRole('button', { name: 'Create room' }).click()
    await expect(page.getByRole('heading', { name: 'Design has no channels yet' })).toBeVisible()
    await page.getByRole('button', { name: 'Create a channel', exact: true }).click()
    await page.getByLabel('Channel name').fill('general')
    await page.getByRole('dialog').getByRole('button', { name: 'Create channel' }).click()
    await expect(page.getByRole('heading', { name: 'Welcome to #general' })).toBeVisible()
    await page.getByRole('button', { name: 'Home', exact: true }).click()
    const invited = syntheticEmail()
    await page.getByRole('button', { name: 'Invite coworkers', exact: true }).click()
    await page.getByLabel('Email address').fill(invited)
    await page.getByRole('dialog').getByRole('button', { name: 'Send invitation' }).click()
    await page.getByRole('button', { name: 'Done', exact: true }).click()
    await page.getByRole('button', { name: 'Design', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Welcome to #general' })).toBeVisible()
    await join(second, invited, 'UI colleague')
    await second.getByRole('button', { name: 'Design', exact: true }).click()
    await expect(second.getByRole('heading', { name: 'Welcome to #general' })).toBeVisible()
    await expect(second.getByRole('status')).toHaveText('Connected')
    await page
      .getByRole('textbox', { name: 'Message #general' })
      .fill('A conversation between two real accounts.')
    await page.getByRole('button', { name: 'Send message' }).click()
    await expect(
      second.getByText('A conversation between two real accounts.', { exact: true }),
    ).toBeVisible()
    await colleague.setOffline(true)
    await page
      .getByRole('textbox', { name: 'Message #general' })
      .fill('Catch up when you are back.')
    await page.getByRole('button', { name: 'Send message' }).click()
    await colleague.setOffline(false)
    await expect(second.getByText('Catch up when you are back.', { exact: true })).toBeVisible({
      timeout: 15000,
    })
    await second.getByRole('textbox', { name: 'Message #general' }).fill('All caught up.')
    await second.getByRole('button', { name: 'Send message' }).click()
    await expect(page.getByText('All caught up.', { exact: true })).toBeVisible()
    const attempts: string[] = []
    await second.route('**/api/messages', async (route) => {
      if (route.request().method() === 'POST') {
        attempts.push(route.request().postData() ?? '')
        await route.abort('connectionfailed')
      } else await route.continue()
    })
    await second
      .getByRole('textbox', { name: 'Message #general' })
      .fill('Keep my message through a restart.')
    await second.getByRole('button', { name: 'Send message' }).click()
    await expect(second.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
    await second.reload()
    await second.getByRole('button', { name: /^Design/ }).click()
    await expect(
      second.getByText('Keep my message through a restart.', { exact: true }),
    ).toBeVisible()
    await second.unroute('**/api/messages')
    second.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/api/messages'))
        attempts.push(request.postData() ?? '')
    })
    await second.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(
      page.getByText('Keep my message through a restart.', { exact: true }),
    ).toBeVisible()
    await expect(second.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0)
    expect(attempts).toHaveLength(2)
    expect(attempts[1]).toEqual(attempts[0])
    await page.screenshot({ path: 'test-results/conversation.png', fullPage: true })
    await second.getByRole('button', { name: 'Home', exact: true }).click()
    await second.getByRole('button', { name: 'UI studio', exact: true }).click()
    await second.getByRole('button', { name: 'Sign out', exact: true }).click()
    await expect(second.getByRole('heading', { name: /Sign in to/ })).toBeVisible()
  } finally {
    await colleague.close()
  }
})
