import { expect, test } from '@playwright/test'
import { join, onboard, syntheticEmail } from './passwordless'
import { useScratchServer } from './server'

useScratchServer('ui')
const shortDate = (date: Date) =>
  date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

test('admins invite, resend, and revoke from Members; members see setup progress but not the page', async ({
  browser,
  page,
}) => {
  const colleague = await browser.newContext()
  const second = await colleague.newPage()
  try {
    const admin = await onboard(page, 'Nallen Admin', 'Harbor members')
    await page.getByRole('button', { name: 'Members', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'People on Harbor members' })).toBeVisible()
    const pending = page.getByRole('region', { name: /^Pending invitations/ })
    const roster = page.getByRole('region', { name: /^Members/ })
    await expect(pending.getByRole('heading')).toHaveText('Pending invitations 0')
    await expect(pending).toContainText(
      'No pending invitationsInvite coworkers by email. Each invitation lasts 7 days.',
    )
    await expect(roster.getByRole('row')).toHaveText([
      'NameRoleJoined',
      `Nallen Admin (you)${admin.email}Admin${shortDate(new Date())}`,
    ])
    await expect(page.getByText('You’re the only member so far.', { exact: false })).toBeVisible()

    await pending.getByRole('button', { name: 'Invite coworkers' }).click()
    const dialog = page.getByRole('dialog')
    const field = dialog.getByLabel('Email address')
    await field.fill(admin.email)
    await dialog.getByRole('button', { name: 'Send invitation' }).click()
    await expect(dialog.getByRole('alert')).toHaveText(
      `${admin.email} is already a member of this server.`,
    )
    await expect(field).toHaveAttribute('aria-invalid', 'true')

    const first = syntheticEmail()
    await page.route('**/api/invitations', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({
            status: 503,
            json: {
              message:
                'The invitation is saved, but the email could not be sent. Try again in a moment.',
            },
          })
        : route.fallback(),
    )
    await field.fill(first)
    await expect(field).not.toHaveAttribute('aria-invalid')
    await dialog.getByRole('button', { name: 'Send invitation' }).click()
    await expect(dialog.getByRole('alert')).toHaveText(
      'The invitation is saved, but the email could not be sent. Try again in a moment.',
    )
    await page.unroute('**/api/invitations')
    await dialog.getByRole('button', { name: 'Try sending again' }).click()
    await expect(dialog.getByRole('heading', { name: 'Invitation sent' })).toBeVisible()
    const expires = new Date(Date.now() + 7 * 86400000)
    await expect(dialog).toContainText(
      `${first} can now join Harbor members. The invitation expires on ${expires.toLocaleDateString('en-US', { dateStyle: 'medium' })}.`,
    )
    await expect(dialog).toContainText(`${first}Pending · 7 days`)
    await dialog.getByRole('button', { name: 'Invite another' }).click()
    await expect(field).toHaveValue('')
    const aiko = syntheticEmail()
    await field.fill(aiko)
    await dialog.getByRole('button', { name: 'Send invitation' }).click()
    await dialog.getByRole('button', { name: 'Done', exact: true }).click()

    await expect(pending.getByRole('heading')).toHaveText('Pending invitations 2')
    await expect(pending.getByRole('row')).toHaveText([
      'EmailInvited byExpiresActions',
      `${first}Nallen Admin${shortDate(expires)}ResendRevoke`,
      `${aiko}Nallen Admin${shortDate(expires)}ResendRevoke`,
    ])
    await page.getByRole('button', { name: `Revoke invitation for ${first}` }).click()
    await expect(pending).toContainText(`Revoked the invitation for ${first}.`)
    await expect(pending.getByRole('heading')).toHaveText('Pending invitations 1')
    await expect(pending.getByRole('row')).toHaveText([
      'EmailInvited byExpiresActions',
      `${aiko}Nallen Admin${shortDate(expires)}ResendRevoke`,
    ])
    await page.getByRole('button', { name: `Resend invitation to ${aiko}` }).click()
    await expect(pending).toContainText(`Sent a fresh invitation to ${aiko}.`)

    await join(second, aiko, 'Aiko Tanaka')
    await expect(second.getByText('Welcome, Aiko', { exact: true })).toBeVisible()
    await expect(
      second.getByRole('heading', { name: 'You’re in Harbor members.', level: 1 }),
    ).toBeVisible()
    await expect(second.getByRole('button', { name: 'Members', exact: true })).toHaveCount(0)
    await expect(second.getByRole('button', { name: 'Invite', exact: true })).toHaveCount(0)
    const setup = second.getByRole('region', { name: 'Set up Harbor members' })
    await expect(setup).toContainText('1 of 3 done')
    await expect(setup.getByRole('listitem')).toHaveText([
      'Invite coworkersYou joined from Nallen Admin’s invitation.Done',
      /^Create the first room.*Waiting on an admin$/,
      /^Add a channel.*Waiting on an admin$/,
    ])
    await expect(setup.getByRole('button')).toHaveCount(0)
    await expect(second.getByText('Only admins see it.', { exact: false })).toHaveCount(0)
    await expect(second.getByRole('list', { name: 'Coworkers' })).toHaveText('Nallen AdminAdmin')
    await expect(second.locator('.account-name > span').first()).toHaveText('Member')

    await page.getByRole('button', { name: 'Home', exact: true }).click()
    await page.getByRole('button', { name: 'Members', exact: true }).click()
    await expect(pending.getByRole('heading')).toHaveText('Pending invitations 0')
    await expect(roster.getByRole('row')).toHaveText([
      'NameRoleJoined',
      `Nallen Admin (you)${admin.email}Admin${shortDate(new Date())}`,
      `Aiko Tanaka${aiko}Member${shortDate(new Date())}`,
    ])
    await expect(page.getByText('You’re the only member so far.', { exact: false })).toHaveCount(0)
    await expect(page.getByRole('list', { name: 'Coworkers' })).toHaveText('Aiko Tanaka')

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
      second.getByRole('heading', { name: /^Good (morning|afternoon|evening), Aiko$/ }),
    ).toBeVisible()
  } finally {
    await colleague.close()
  }
})
