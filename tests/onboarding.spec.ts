import { expect, test } from '@playwright/test'
import { tailscale } from '../apps/server/scripts/harness'
import {
  actAs,
  browserApp,
  expectHome,
  inviteCode,
  loginOf,
  onboard,
  serverURL,
  skipProfile,
} from './accounts'
import { setupCode, useScratchServer } from './server'

useScratchServer('ui')

test('a visitor without an identity is told what is wrong and how to fix it', async ({
  browser,
  page,
}) => {
  await page.goto(browserApp)
  await expect(page.getByRole('heading', { name: 'Open Huddle through Tailscale' })).toBeVisible()
  await expect(page.locator('main')).toContainText(`Open ${serverURL} with Tailscale connected.`)
  await expect(page.getByLabel('Setup code')).toHaveCount(0)
  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Open Huddle through Tailscale' })).toBeVisible()

  const tagged = await browser.newContext({
    extraHTTPHeaders: { 'X-Forwarded-Host': new URL(serverURL).host },
  })
  const funnel = await browser.newContext({
    extraHTTPHeaders: { ...tailscale(loginOf('funnel')), 'Tailscale-Funnel-Request': '?1' },
  })
  try {
    const taggedPage = await tagged.newPage()
    await taggedPage.goto(browserApp)
    await expect(
      taggedPage.getByRole('heading', { name: "Tailscale doesn't say who you are" }),
    ).toBeVisible()
    await expect(taggedPage.locator('main')).toContainText('Tagged devices have no user.')
    const funnelPage = await funnel.newPage()
    await funnelPage.goto(browserApp)
    await expect(
      funnelPage.getByRole('heading', { name: "Huddle isn't available through Funnel" }),
    ).toBeVisible()
  } finally {
    await tagged.close()
    await funnel.close()
  }

  await actAs(page, 'avery')
  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Set up this server' })).toBeVisible()
  await expect(page.getByText(loginOf('avery'), { exact: true })).toBeVisible()
})

test('the host sets up with the setup code and only a friend with the invite can join', async ({
  browser,
  page,
}) => {
  const strangerContext = await browser.newContext({
    extraHTTPHeaders: tailscale(loginOf('nobody')),
  })
  const memberContext = await browser.newContext({ extraHTTPHeaders: tailscale(loginOf('jonas')) })
  const hashContext = await browser.newContext({ extraHTTPHeaders: tailscale(loginOf('tabbed')) })
  try {
    await actAs(page, 'avery')
    await page.goto(browserApp)
    await expect(page.getByRole('heading', { name: 'Set up this server' })).toBeVisible()
    await expect(page.getByLabel('Your name')).toHaveValue('avery')
    await page.screenshot({ path: test.info().outputPath('onboarding.png') })
    await page.getByLabel('Setup code').fill('WRONG-SETUP-CODE')
    await page.getByLabel('Server name').fill('Harbor')
    await page.getByRole('button', { name: 'Create the server', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText(
      'This setup code is invalid or has expired. Copy the newest code from the server log. It changes each time the server restarts.',
    )
    await expect(page.getByLabel('Setup code')).toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByRole('heading', { name: 'Set up this server' })).toBeVisible()

    await onboard(page, 'avery', 'Harbor', browserApp)
    await expectHome(page)
    await expect(page.getByRole('region', { name: 'Set up Harbor' })).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('admin-home.png') })

    await page.getByRole('button', { name: 'Share invite', exact: true }).first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('button', { name: 'Copy invite' })).toHaveCount(1)
    await expect(dialog).toContainText('They need access to this machine in Tailscale first.')
    await expect(dialog).not.toContainText('#join=')
    await page.screenshot({ path: test.info().outputPath('invite-dialog.png') })
    const code = await inviteCode(page)
    await dialog.getByRole('button', { name: 'Done', exact: true }).click()

    const stranger = await strangerContext.newPage()
    await stranger.goto(browserApp)
    await expect(stranger.getByRole('heading', { name: 'Join Harbor' })).toBeVisible()
    await expect(stranger.getByLabel('Setup code')).toHaveCount(0)
    await expect(stranger.getByRole('button', { name: 'Create account' })).toHaveCount(0)
    await expect(stranger.getByText(loginOf('nobody'), { exact: true })).toBeVisible()
    await expect(stranger.getByText('Been here before?', { exact: false })).toBeVisible()
    await stranger.screenshot({ path: test.info().outputPath('uninvited-join.png') })
    const invite = stranger.getByLabel('Invite link')
    const proceed = stranger.getByRole('button', { name: 'Continue', exact: true })
    await invite.fill('huddle:eyJ2IjoxfQ')
    await proceed.click()
    await expect(stranger.getByRole('alert')).toHaveText(
      'This invite is from an older Huddle. Ask for a new one.',
    )
    await invite.fill(`https://elsewhere.test/#join=${code}`)
    await proceed.click()
    await expect(stranger.getByRole('alert')).toHaveText(
      'That invite is for elsewhere.test. Open it there.',
    )
    await stranger.getByRole('button', { name: 'Check again', exact: true }).click()
    await expect(stranger.getByRole('status')).toHaveText(
      "This login isn't linked to an account yet.",
    )
    await invite.fill(`${serverURL}/#join=not-a-real-join-code-xx`)
    await proceed.click()
    await stranger.getByRole('button', { name: 'Create account', exact: true }).click()
    await expect(stranger.getByRole('alert')).toHaveText(
      "This invite doesn't work. Ask your host for a new invite link.",
    )
    await expect(stranger.getByLabel('Invite link')).toBeVisible()
    const openTab = await hashContext.newPage()
    await openTab.goto(browserApp)
    await expect(openTab.getByLabel('Invite link')).toBeVisible()
    await openTab.evaluate((join) => {
      window.location.hash = join
    }, `#join=${code}`)
    await expect(openTab.getByRole('button', { name: 'Create account' })).toBeVisible()
    await expect(openTab).toHaveURL(browserApp)
    const second = await stranger.request.post(`${serverURL}/api/access`, {
      headers: { Origin: serverURL },
      data: {
        kind: 'account.setup',
        code: setupCode,
        serverName: 'Hijack',
        name: 'Hijack',
      },
    })
    expect(second.status()).toBe(400)

    const invited = await memberContext.newPage()
    await invited.goto(`${serverURL}/#join=${code}`)
    await expect(invited.getByRole('heading', { name: 'Join Harbor' })).toBeVisible()
    await expect(invited).toHaveURL(browserApp)
    await expect(invited.getByLabel('Your name')).toHaveValue('jonas')
    await invited.getByLabel('Your name').fill('Jonas H')
    await invited.getByRole('button', { name: 'Create account', exact: true }).click()
    await skipProfile(invited)
    await expectHome(invited)
    await expect(
      invited.getByText('An admin is still setting things up.', { exact: false }),
    ).toBeVisible()
    await expect(invited.getByRole('button', { name: 'Share invite' })).toHaveCount(0)
    expect(
      await invited.evaluate(
        (origin) => localStorage.getItem(`huddle.join-code:${origin}`),
        serverURL,
      ),
    ).toBeNull()
    const denied = await invited.request.get(`${serverURL}/api/invite`)
    expect(denied.status()).toBe(403)
    await invited.reload()
    await expectHome(invited)
  } finally {
    await strangerContext.close()
    await memberContext.close()
    await hashContext.close()
  }
})
