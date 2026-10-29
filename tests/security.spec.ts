import { expect, test } from '@playwright/test'
import { browserLogin, expectHome, member, serverPassword } from './passwordless'
import { useScratchServer } from './server'

const server = useScratchServer('api')

test('profile name persists for a password account', async ({ page }) => {
  await member(server.admin, page, 'profile', browserLogin)
  await expectHome(page)
  await page.getByRole('button', { name: 'Account security', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Account security', exact: true })).toBeVisible()
  await expect(page.getByText('@member.huddle.invalid')).toHaveCount(0)
  await page.getByRole('button', { name: 'Profile', exact: true }).click()
  await expect(page.getByRole('button', { name: 'circle', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByRole('button', { name: 'indigo', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.getByLabel('Name', { exact: true }).fill('Updated profile owner')
  await page.getByRole('button', { name: 'Save profile', exact: true }).click()
  await page.reload()
  await page.getByRole('button', { name: 'Account security', exact: true }).click()
  await page.getByRole('button', { name: 'Profile', exact: true }).click()
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Updated profile owner')
})

test('browser passkeys register, rename, sign in and remove with the account password', async ({
  page,
  context,
}) => {
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  try {
    const identity = await member(server.admin, page, 'passkey', browserLogin)
    await page.getByRole('button', { name: 'Account security', exact: true }).click()
    await expect(page.getByText('Continue with company login')).toHaveCount(0)
    await page.getByRole('button', { name: '+ Add passkey', exact: true }).click()
    await expect(page.getByText('Confirm this change with your password.')).toBeVisible()
    await page.getByLabel('Passkey name').fill('Verified browser key')
    await page.getByLabel('Password').fill(identity.password)
    await page.getByRole('button', { name: 'Add passkey', exact: true }).click()
    await expect(page.getByText('Verified browser key', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Rename', exact: true }).click()
    await page.getByLabel('Passkey name').fill('Renamed browser key')
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await page.getByRole('button', { name: 'Confirm with passkey', exact: true }).click()
    await expect(page.getByText('Renamed browser key', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Sign out', exact: true }).click()
    await page.getByRole('button', { name: 'Sign in with a passkey', exact: true }).click()
    await expectHome(page)
    await page.getByRole('button', { name: 'Account security', exact: true }).click()
    await page.getByRole('button', { name: 'Remove', exact: true }).click()
    await page.getByRole('button', { name: 'Confirm with passkey', exact: true }).click()
    await expect(page.getByText('No passkeys added.', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Sign out', exact: true }).click()
    const form = page.locator('form').filter({
      has: page.getByRole('button', { name: 'Sign in', exact: true }),
    })
    await form.getByLabel('Username').fill(identity.username)
    await form.getByLabel('Password').fill(serverPassword)
    await form.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page.getByRole('alert')).toBeVisible()
    await form.getByLabel('Password').fill(identity.password)
    await form.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expectHome(page)
  } finally {
    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId }).catch(() => {})
    await cdp.detach().catch(() => {})
  }
})
