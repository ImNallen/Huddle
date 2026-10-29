import { expect, test } from '@playwright/test'
import { expectHome, friendPassword, inviteCode, join, onboard, signIn } from './passwordless'
import { useScratchServer } from './server'

useScratchServer('ui')
const shortDate = (date: Date) =>
  date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

test('admins share an invite and reset a password; members see setup progress but not the page', async ({
  browser,
  page,
}) => {
  const colleague = await browser.newContext()
  const second = await colleague.newPage()
  try {
    await onboard(page, 'nallen', 'Harbor members')
    await page.getByRole('button', { name: 'Members', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'People on Harbor members' })).toBeVisible()
    const roster = page.getByRole('region', { name: /^Members/ })
    await expect(page.getByRole('region', { name: /^Pending invitations/ })).toHaveCount(0)
    await expect(roster.getByRole('row')).toHaveText([
      'NameRoleJoinedActions',
      `nallen (you)Admin${shortDate(new Date())}Reset password`,
    ])
    await expect(page.getByText('You’re the only member so far.', { exact: false })).toBeVisible()

    await page.getByRole('button', { name: 'Share invite', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('button', { name: 'Copy invite' }).first()).toBeVisible()
    await expect(dialog).not.toContainText('huddle:')
    const code = await inviteCode(page)
    await dialog.getByRole('button', { name: 'Done', exact: true }).click()

    await join(second, 'aiko', code)
    await expect(second.getByText('Welcome, aiko', { exact: true })).toBeVisible()
    await expect(
      second.getByRole('heading', { name: 'You’re in Harbor members.', level: 1 }),
    ).toBeVisible()
    await expect(second.getByRole('button', { name: 'Members', exact: true })).toHaveCount(0)
    await expect(second.getByRole('button', { name: 'Share invite', exact: true })).toHaveCount(0)
    const setup = second.getByRole('region', { name: 'Set up Harbor members' })
    await expect(setup).toContainText('1 of 3 done')
    await expect(setup.getByRole('listitem')).toHaveText([
      'You joined this serverYou joined from an invite.Done',
      /^Create the first room.*Waiting on an admin$/,
      /^Add a channel.*Waiting on an admin$/,
    ])
    await expect(setup.getByRole('button')).toHaveCount(0)
    await expect(second.getByText('Only admins see it.', { exact: false })).toHaveCount(0)
    await expect(second.getByRole('list', { name: 'Friends' })).toHaveText('nallenAdmin')
    await expect(second.locator('.account-name > span').first()).toHaveText('Member')

    const denied = await second.evaluate(async () => {
      const response = await fetch('/api/members/password', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'nallen', password: 'replaced-secret' }),
      })
      return response.status
    })
    expect(denied).toBe(403)

    await page.getByRole('button', { name: 'Home', exact: true }).click()
    await page.getByRole('button', { name: 'Members', exact: true }).click()
    await expect(roster.getByRole('row')).toHaveText([
      'NameRoleJoinedActions',
      `nallen (you)Admin${shortDate(new Date())}Reset password`,
      `aikoMember${shortDate(new Date())}Reset password`,
    ])
    await expect(page.getByText('You’re the only member so far.', { exact: false })).toHaveCount(0)
    await expect(page.getByRole('list', { name: 'Friends' })).toHaveText('aiko')

    await page.getByRole('button', { name: 'Reset password', exact: true }).nth(1).click()
    await page.getByLabel('New password for aiko').fill('replaced-secret')
    await page.getByRole('button', { name: 'Save password', exact: true }).click()
    await expect(
      page.getByText('Password updated. They can sign in with the new one.', { exact: true }),
    ).toBeVisible()

    await second.reload()
    await expect(second.getByRole('heading', { name: 'Sign in to Harbor members' })).toBeVisible()
    const stale = second.locator('form').filter({
      has: second.getByRole('button', { name: 'Sign in', exact: true }),
    })
    await stale.getByLabel('Username').fill('aiko')
    await stale.getByLabel('Password').fill(friendPassword)
    await stale.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(second.getByRole('alert')).toHaveText(
      "That username or password isn't right. Check both and try again.",
    )
    await signIn(second, 'aiko', 'replaced-secret')

    await page.getByRole('button', { name: 'Create room', exact: true }).click()
    await page.getByLabel('Room name').fill('Product')
    await page.getByRole('dialog').getByRole('button', { name: 'Create room' }).click()
    await expect(setup).toContainText('2 of 3 done')
    await expect(setup.getByRole('listitem').nth(1)).toHaveText('Create the first roomProductDone')
    await page.getByRole('button', { name: 'Create a channel', exact: true }).click()
    await page.getByLabel('Channel name').fill('general')
    await page.getByRole('dialog').getByRole('button', { name: 'Create channel' }).click()
    await expect(setup).toHaveCount(0)
    await expect(
      second.getByRole('heading', { name: /^Good (morning|afternoon|evening), aiko$/ }),
    ).toBeVisible()
  } finally {
    await colleague.close()
  }
})
