import { expect, test } from '@playwright/test'
import { inviteCode, join, onboard, railTile } from './accounts'
import { useScratchServer } from './server'

useScratchServer('ui')

test('an invited colleague joins the server, sends, reconnects, and loses their identity', async ({
  browser,
  page,
}) => {
  const colleague = await browser.newContext()
  const second = await colleague.newPage()
  try {
    await onboard(page, 'uiowner', 'UI studio')
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
    await page.getByRole('button', { name: 'Create text channel', exact: true }).click()
    await page.getByLabel('Channel name').fill('general')
    await page.getByRole('dialog').getByRole('button', { name: 'Create channel' }).click()
    await expect(page.getByRole('dialog').getByRole('alert')).toHaveText(
      'That name is already in use.',
    )
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByRole('button', { name: 'general', exact: true })).toHaveCount(1)
    await page.getByRole('button', { name: 'Home', exact: true }).click()
    await page.getByRole('button', { name: 'Share invite', exact: true }).first().click()
    const code = await inviteCode(page)
    await page.getByRole('button', { name: 'Done', exact: true }).click()
    await railTile(page, 'Design').click()
    await expect(page.getByRole('heading', { name: 'Welcome to #general' })).toBeVisible()
    await join(second, 'colleague', code)
    await railTile(second, 'Design').click()
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
    await railTile(second, 'Design').click()
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

    await page.getByRole('textbox', { name: 'Message #general' }).fill('First of a run.')
    await page.getByRole('button', { name: 'Send message' }).click()
    await page.getByRole('textbox', { name: 'Message #general' }).fill('Second of a run.')
    await page.getByRole('button', { name: 'Send message' }).click()
    const thread = page.getByRole('main')
    const posted = (text: string) => thread.getByRole('article').filter({ hasText: text })
    await expect(posted('Second of a run.')).toBeVisible()
    await expect(posted('Second of a run.').getByText('uiowner', { exact: true })).toHaveCount(0)
    await expect(posted('Second of a run.').getByRole('img')).toHaveCount(0)
    const start = posted('First of a run.')
    await expect(start.getByText('uiowner', { exact: true })).toBeVisible()
    await expect(start.getByRole('img')).toBeVisible()
    await expect(posted('All caught up.').getByText('colleague', { exact: true })).toBeVisible()
    await expect(
      posted('Keep my message through a restart.').getByText('colleague', { exact: true }),
    ).toHaveCount(0)
    const left = async (text: string) =>
      (await thread.getByText(text, { exact: true }).boundingBox())?.x
    expect(await left('First of a run.')).toBe(await left('All caught up.'))

    const members = page.getByRole('list', { name: 'Members' })
    const toggle = page.getByRole('button', { name: 'Member list', exact: true })
    await expect(members).toHaveText('Admins — 1uiownerMembers — 1colleague')
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await toggle.click()
    await expect(members).toHaveCount(0)
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await page.getByRole('button', { name: /^Home/ }).click()
    await expect(members).toHaveCount(0)
    await toggle.click()
    await expect(members).toBeVisible()
    await railTile(page, 'Design').click()
    const homeTile = page.getByRole('button', { name: /^Home/ })
    const homeTip = page.locator('.rail-tooltip')
    await expect(homeTip).toHaveText('Design')
    await expect(homeTip).toHaveCSS('opacity', '1')
    await page.mouse.move(640, 400)
    await expect(homeTip).toHaveCSS('opacity', '0')
    await homeTile.hover()
    await expect(homeTip).toHaveText('Home')
    await expect(homeTip).toHaveCSS('opacity', '1')
    await page.mouse.move(640, 400)
    await expect(homeTip).toHaveCSS('opacity', '0')
    await page.keyboard.press('Shift')
    await homeTile.focus()
    await expect(homeTip).toHaveCSS('opacity', '1')
    await homeTile.blur()
    await page.getByRole('button', { name: 'Create text channel', exact: true }).click()
    await page.getByLabel('Channel name').fill('random')
    await page.getByRole('dialog').getByRole('button', { name: 'Create channel' }).click()
    await expect(page.getByRole('heading', { name: 'Welcome to #random' })).toBeVisible()
    await page.getByRole('button', { name: /^Home/ }).click()
    await expect(members).toBeVisible()
    await railTile(page, 'Design').click()
    await expect(page.getByRole('heading', { name: 'Welcome to #random' })).toBeVisible()

    await page.route('**/api/messages?channelId=*', async (route) => {
      const response = await route.fetch()
      const history: { body: string; createdAt: string }[] = await response.json()
      const earlier = new Date(Date.now() - 8 * 60 * 1000).toISOString()
      await route.fulfill({
        response,
        json: history.map((message) =>
          message.body === 'First of a run.' ? { ...message, createdAt: earlier } : message,
        ),
      })
    })
    await page.reload()
    await railTile(page, 'Design').click()
    await expect(posted('Second of a run.')).toBeVisible()
    await expect(posted('Second of a run.').getByText('uiowner', { exact: true })).toBeVisible()
    await page.unroute('**/api/messages?channelId=*')

    await second.getByRole('button', { name: 'Design menu', exact: true }).click()
    await expect(second.getByRole('button', { name: /sign out/i })).toHaveCount(0)
    await second.keyboard.press('Escape')
    await colleague.setExtraHTTPHeaders({})
    await second.reload()
    await expect(
      second.getByRole('heading', { name: 'Open Huddle through Tailscale' }),
    ).toBeVisible()
    await expect(second.getByRole('textbox', { name: 'Message #general' })).toHaveCount(0)
  } finally {
    await colleague.close()
  }
})
