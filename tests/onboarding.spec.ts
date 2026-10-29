import { expect, test } from '@playwright/test'
import { browserLogin, expectHome, inviteCode, join, onboard, serverURL } from './passwordless'
import { setupCode, useScratchServer } from './server'

useScratchServer('ui')

test('the host sets up with the setup code and only a friend with the invite can join', async ({
  browser,
  page,
}) => {
  const strangerContext = await browser.newContext()
  const memberContext = await browser.newContext()
  try {
    await page.goto(browserLogin)
    await expect(page.getByRole('heading', { name: 'Set up this server' })).toBeVisible()
    await expect(page.getByLabel('Work email')).toHaveCount(0)
    await expect(page.getByLabel('Username')).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('onboarding.png') })
    await page.getByLabel('Setup code').fill('WRONG-SETUP-CODE')
    await page.getByLabel('Server name').fill('Harbor')
    await page.getByLabel('Username').fill('avery')
    await page.getByLabel('Password').fill('server-secret')
    await page.getByRole('button', { name: 'Create the server', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText(
      'This setup code is invalid or has expired. Copy the newest code from the server log. It changes each time the server restarts.',
    )
    await expect(page.getByLabel('Setup code')).toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByRole('heading', { name: 'Set up this server' })).toBeVisible()

    await onboard(page, 'avery', 'Harbor', browserLogin)
    await expectHome(page)
    await expect(page.getByRole('region', { name: 'Set up Harbor' })).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('admin-home.png') })

    await page.getByRole('button', { name: 'Share invite', exact: true }).first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('button', { name: 'Copy invite' }).first()).toBeVisible()
    await expect(dialog).not.toContainText('huddle:')
    await page.screenshot({ path: test.info().outputPath('invite-dialog.png') })
    const code = await inviteCode(page)
    await dialog.getByRole('button', { name: 'Done', exact: true }).click()

    const stranger = await strangerContext.newPage()
    await stranger.goto(browserLogin)
    await expect(stranger.getByRole('heading', { name: 'Sign in to Harbor' })).toBeVisible()
    await expect(stranger.getByLabel('Setup code')).toHaveCount(0)
    await expect(stranger.getByLabel('Work email')).toHaveCount(0)
    await expect(
      stranger.getByText('Need access? Ask an admin of this server for an invite.'),
    ).toBeVisible()
    await stranger.getByLabel('Username').fill('nobody')
    await stranger.getByLabel('Password').fill('not-a-real-password')
    await stranger.screenshot({ path: test.info().outputPath('uninvited-signin.png') })
    await stranger.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(stranger.getByRole('alert')).toHaveText(
      "That username or password isn't right. Check both and try again.",
    )
    const second = await stranger.request.post(`${serverURL}/api/access`, {
      headers: { Origin: serverURL },
      data: {
        kind: 'account.setup',
        code: setupCode,
        serverName: 'Hijack',
        username: 'hijack',
        password: 'hijack-password',
      },
    })
    expect(second.status()).toBe(400)

    const colleague = await memberContext.newPage()
    await join(colleague, 'jonas', code, browserLogin)
    await expectHome(colleague)
    await expect(
      colleague.getByText('An admin is still setting things up.', { exact: false }),
    ).toBeVisible()
    await expect(colleague.getByRole('button', { name: 'Share invite' })).toHaveCount(0)
    const denied = await colleague.request.post(`${serverURL}/api/members/password`, {
      headers: { Origin: serverURL },
      data: { userId: 'someone', password: 'replaced-secret' },
    })
    expect(denied.status()).toBe(403)
  } finally {
    await strangerContext.close()
    await memberContext.close()
  }
})
