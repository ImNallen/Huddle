import { expect, test, type Page } from '@playwright/test'
import { Account, ServerInvite, parseInvite } from '../packages/contracts/src/index'
import { Client } from '../apps/server/scripts/harness'
import { actAs, browserApp, expectHome, railTile, serverURL } from './accounts'
import { setupCode, useScratchServer } from './server'

useScratchServer('ui')
async function capture(page: Page, name: string) {
  await page.getByRole('heading', { level: 1 }).first().click()
  await page.mouse.move(0, 0)
  await page.evaluate(() => document.fonts.ready)
  const path = test.info().outputPath(`${name}.png`)
  await page.screenshot({ path, animations: 'disabled' })
  await test.info().attach(name, { path, contentType: 'image/png' })
}
async function both(page: Page, name: string) {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await capture(page, `${name}-${colorScheme}`)
  }
}

test('onboarding matches both themes and completes setup, optional profile, retries and invite joining', async ({
  browser,
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.context().route('**/*', (route) => route.continue())
  await actAs(page, 'adam')
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Connect to Huddle', exact: true })).toHaveText(
    'Your people are here.',
  )
  await expect(page.locator('.access-main')).toHaveCSS('width', '480px')
  await expect(page.locator('.access-brand .huddle-logo')).toHaveCSS('width', '36px')
  await both(page, 'onboarding-connect')
  const address = page.getByLabel('Invite link or server address')
  await address.fill(serverURL)
  await page.route('**/api/info', (route) => route.abort(), { times: 1 })
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText("Can't reach")
  await expect(address).toHaveValue(serverURL)
  await both(page, 'onboarding-unreachable')
  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Set up this server', exact: true })).toBeVisible()
  await page.goto(browserApp)
  await page.getByLabel('Your name').fill('Adam Nilsson')
  await page.getByLabel('Server name').fill('Our place')
  await both(page, 'onboarding-setup')
  await page.getByLabel('Setup code').fill('WRONG-SETUP')
  await page.getByRole('button', { name: 'Create the server', exact: true }).click()
  await expect(page.getByLabel('Setup code')).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByLabel('Your name')).toHaveValue('Adam Nilsson')
  await both(page, 'onboarding-setup-error')
  await page.getByLabel('Setup code').fill(setupCode)
  await page.getByRole('button', { name: 'Create the server', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Make it yours.', exact: true })).toBeVisible()
  await expect(
    page.getByText('Choose how you appear in Our place. You can change this later in Settings.', {
      exact: true,
    }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'square', exact: true }).click()
  await page.getByRole('button', { name: 'indigo', exact: true }).click()
  await expect(page.locator('.access-main')).toHaveCSS('width', '640px')
  await expect(page.locator('.access-avatar-stage .access-avatar')).toHaveCSS('width', '64px')
  for (const shape of ['circle', 'square', 'bean', 'hexagon', 'triangle', 'flower'])
    await expect(page.getByRole('button', { name: shape, exact: true }).getByRole('img')).toHaveCSS(
      'width',
      '28px',
    )
  await expect(page.locator('.access-preview .access-avatar')).toHaveCSS('width', '32px')
  await both(page, 'onboarding-profile')
  await page.getByRole('button', { name: 'Photo', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Save and continue', exact: true })).toBeDisabled()
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 8
    canvas.height = 8
    const context = canvas.getContext('2d')
    if (!context) throw new Error('No canvas')
    context.fillStyle = '#7695bb'
    context.fillRect(0, 0, 8, 8)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  if (!png) throw new Error('Missing photo fixture')
  await page.getByLabel('Upload a photo').setInputFiles({
    name: 'profile.png',
    mimeType: 'image/png',
    buffer: Buffer.from(png, 'base64'),
  })
  await expect(page.locator('.access-avatar-stage img.access-avatar-photo')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save and continue', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Mascot', exact: true }).click()
  await page.getByLabel('Your name', { exact: true }).fill('Adam N')
  await page.getByRole('button', { name: 'hexagon', exact: true }).click()
  await page.getByRole('button', { name: 'teal', exact: true }).click()
  await page.route(
    '**/api/access',
    (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'unavailable' }),
      }),
    { times: 1 },
  )
  await page.getByRole('button', { name: 'Save and continue', exact: true }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page.getByLabel('Your name', { exact: true })).toHaveValue('Adam N')
  await expect(page.getByRole('button', { name: 'hexagon', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.getByRole('button', { name: 'Save and continue', exact: true }).click()
  await expectHome(page)
  await expect(page.locator('.account-name > strong')).toHaveText('Adam N')
  const admin = new Client(serverURL, 'adam@huddle.test')
  await admin.stage()
  expect(Account.parse((await admin.call('/api/account')).value).user.avatar).toEqual({
    kind: 'mascot',
    shape: 'hexagon',
    color: 'teal',
  })
  const checklist = page.getByRole('region', { name: 'Set up Our place', exact: true })
  await expect(checklist).toContainText('0 of 3 done')
  await both(page, 'onboarding-home')
  await page.reload()
  await expectHome(page)
  await expect(page.getByRole('heading', { name: 'Make it yours.', exact: true })).toHaveCount(0)
  await checklist.getByRole('button', { name: 'Create room', exact: true }).click()
  await page.getByLabel('Room name').fill('The lounge')
  await page.getByRole('dialog').getByRole('button', { name: 'Create room', exact: true }).click()
  await railTile(page, 'Home').click()
  await expect(checklist).toContainText('1 of 3 done')
  await checklist.getByRole('button', { name: 'Add channel', exact: true }).click()
  await page.getByLabel('Channel name').fill('general')
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Create channel', exact: true })
    .click()
  await railTile(page, 'Home').click()
  await expect(checklist).toContainText('2 of 3 done')
  const code = parseInvite(ServerInvite.parse((await admin.call('/api/invite')).value).invite).code
  const friendContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce',
  })
  const friend = await friendContext.newPage()
  try {
    await actAs(friend, 'maya')
    await friend.goto(browserApp)
    await expect(friend.getByLabel('Invite link')).toBeVisible()
    await both(friend, 'onboarding-need-invite')
    await friend.getByLabel('Invite link').fill(`${serverURL}/#join=not-a-real-join-code-xx`)
    await friend.getByRole('button', { name: 'Continue', exact: true }).click()
    await friend.getByLabel('Your name').fill('Maya Lind')
    await friend.getByRole('button', { name: 'Create account', exact: true }).click()
    await expect(friend.getByRole('alert')).toContainText("This invite doesn't work.")
    await expect(friend.getByLabel('Invite link')).toHaveValue('')
    await both(friend, 'onboarding-invite-error')
    await friend.getByLabel('Invite link').fill(`${serverURL}/#join=${code}`)
    await friend.getByRole('button', { name: 'Continue', exact: true }).click()
    await expect(friend.getByLabel('Your name')).toHaveValue('Maya Lind')
    await both(friend, 'onboarding-join')
    await friend.getByRole('button', { name: 'Create account', exact: true }).click()
    await expect(friend.getByRole('heading', { name: 'Make it yours.', exact: true })).toBeVisible()
    await friend.getByRole('button', { name: 'flower', exact: true }).click()
    await friend.getByLabel('Your name').fill('Unsaved name')
    await friend.getByRole('button', { name: 'Skip for now', exact: true }).click()
    await expectHome(friend)
    await expect(friend.locator('.account-name > strong')).toHaveText('Maya Lind')
    await friend.reload()
    await expectHome(friend)
    await expect(friend.getByRole('heading', { name: 'Make it yours.', exact: true })).toHaveCount(
      0,
    )
    await friend.setViewportSize({ width: 390, height: 740 })
    await friend.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(friend.getByLabel('Name', { exact: true })).toHaveValue('Maya Lind')
  } finally {
    await friendContext.close()
  }
  const identityContext = await browser.newContext()
  const identityPage = await identityContext.newPage()
  try {
    await actAs(identityPage, 'identityprofile')
    await identityPage.goto(`${serverURL}/#join=${code}`)
    await identityPage.getByLabel('Your name').fill('Original profile')
    await identityPage.getByRole('button', { name: 'Create account', exact: true }).click()
    await expect(
      identityPage.getByRole('heading', { name: 'Make it yours.', exact: true }),
    ).toBeVisible()
    await identityPage.getByLabel('Your name').fill('Typed before identity changed')
    await actAs(identityPage, 'adam')
    await identityPage.getByRole('button', { name: 'Save and continue', exact: true }).click()
    await expectHome(identityPage)
    await expect(identityPage.locator('.account-name > strong')).toHaveText('Adam N')
    expect(Account.parse((await admin.call('/api/account')).value).user.name).toBe('Adam N')
    await actAs(identityPage, 'identityprofile')
    await identityPage.reload()
    await expectHome(identityPage)
    await expect(identityPage.locator('.account-name > strong')).toHaveText('Original profile')
  } finally {
    await identityContext.close()
  }
})
