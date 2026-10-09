import { expect, test } from '@playwright/test'
import { mailIds, nextMail } from '../apps/server/scripts/harness'
import { browserLogin, expectHome, join, onboard, serverURL, syntheticEmail } from './passwordless'
import { setupCode, useScratchServer } from './server'

useScratchServer('ui')

test('the operator onboards with the setup code and only invited addresses can join', async ({
  browser,
  page,
}) => {
  const strangerContext = await browser.newContext()
  const memberContext = await browser.newContext()
  try {
    await page.goto(browserLogin)
    await expect(page.getByRole('heading', { name: 'Set up this server' })).toBeVisible()
    await expect(page.getByLabel('Work email')).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath('onboarding.png') })
    await page.getByLabel('Setup code').fill('WRONG-SETUP-CODE')
    await page.getByLabel('Server name').fill('Harbor')
    await page.getByLabel('Admin email').fill(syntheticEmail())
    await page.getByRole('button', { name: 'Continue with email', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText(
      'That code or action could not be verified. Please try again.',
    )
    await expect(page.getByRole('heading', { name: 'Set up this server' })).toBeVisible()

    await onboard(page, 'Avery Admin', 'Harbor', browserLogin)
    await expectHome(page)
    await expect(page.getByRole('region', { name: 'Set up Harbor' })).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('admin-home.png') })

    const invited = syntheticEmail()
    await page.getByRole('button', { name: 'Invite coworkers', exact: true }).click()
    await page.getByLabel('Work email').fill(invited)
    await page.screenshot({ path: test.info().outputPath('invite-dialog.png') })
    const before = await mailIds(invited)
    await page.getByRole('dialog').getByRole('button', { name: 'Send invitation' }).click()
    await expect(page.getByRole('heading', { name: 'Invitation sent' })).toBeVisible()
    await expect(page.getByText(`${invited} can now join Harbor.`, { exact: false })).toBeVisible()
    const invitation = await nextMail(invited, before)
    expect(invitation.subject).toBe('Avery Admin invited you to Harbor')
    expect(invitation.text).toContain(`Open ${serverURL}/login and continue with ${invited}`)
    await page.getByRole('button', { name: 'Done', exact: true }).click()

    const stranger = await strangerContext.newPage()
    await stranger.goto(browserLogin)
    await expect(stranger.getByRole('heading', { name: 'Sign in to Harbor' })).toBeVisible()
    await expect(stranger.getByLabel('Setup code')).toHaveCount(0)
    await expect(
      stranger.getByText('Need access? Ask an admin of this server for an invite.'),
    ).toBeVisible()
    const uninvited = syntheticEmail()
    await stranger.getByLabel('Work email').fill(uninvited)
    await stranger.screenshot({ path: test.info().outputPath('uninvited-signin.png') })
    const strangerMail = await mailIds(uninvited)
    await stranger.getByRole('button', { name: 'Continue with email', exact: true }).click()
    await expect(stranger.getByRole('heading', { name: 'Check your email' })).toBeVisible()
    await stranger.screenshot({ path: test.info().outputPath('uninvited-check-email.png') })
    const refusal = await nextMail(uninvited, strangerMail)
    expect(refusal.subject).toBe('Harbor sign-in request')
    expect(refusal.text).toContain('there is no account for it on this server')
    expect(refusal.text).not.toMatch(/\b\d{6}\b/)
    await stranger.getByLabel('Code', { exact: true }).fill('123456')
    await stranger.getByRole('button', { name: 'Verify', exact: true }).click()
    await expect(stranger.getByRole('alert')).toBeVisible()
    const second = await stranger.request.post(`${serverURL}/api/access`, {
      headers: { Origin: serverURL },
      data: { kind: 'setup.start', code: setupCode, serverName: 'Hijack', email: uninvited },
    })
    expect(second.status()).toBe(400)

    const colleague = await memberContext.newPage()
    await join(colleague, invited, 'Jonas Member', browserLogin)
    await expectHome(colleague)
    await expect(
      colleague.getByText('An admin is still setting things up.', { exact: false }),
    ).toBeVisible()
    await expect(colleague.getByRole('button', { name: 'Invite coworkers' })).toHaveCount(0)
    const denied = await colleague.request.post(`${serverURL}/api/invitations`, {
      headers: { Origin: serverURL },
      data: { email: syntheticEmail() },
    })
    expect(denied.status()).toBe(403)
  } finally {
    await strangerContext.close()
    await memberContext.close()
  }
})
