import { expect, test } from '@playwright/test'
import {
  browserLogin,
  expectHome,
  member,
  nextTotp,
  sendEmail,
  signOut,
  signin,
} from './passwordless'
import { useScratchServer } from './server'

const server = useScratchServer('api')

test('profile persists and sensitive recovery changes require a fresh factor and acknowledgement', async ({
  page,
}) => {
  const identity = await member(server.admin, page, 'Security profile owner', browserLogin)
  await expectHome(page)
  await page.getByRole('button', { name: 'Account security', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Account security', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Profile', exact: true }).click()
  await expect(page.getByRole('button', { name: 'flower', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByRole('button', { name: 'teal', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.getByLabel('Display name').fill('Updated profile owner')
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.reload()
  await page.getByRole('button', { name: 'Account security', exact: true }).click()
  await page.getByRole('button', { name: 'Profile', exact: true }).click()
  await expect(page.getByLabel('Display name')).toHaveValue('Updated profile owner')
  await page.getByRole('button', { name: 'Account security', exact: true }).click()
  await page.getByRole('button', { name: 'Regenerate codes', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByLabel('Authenticator code').fill(identity.enrolledCode)
  await page.getByRole('button', { name: 'Confirm change', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toHaveCount(0)
  await page.getByLabel('Authenticator code').fill(await nextTotp(identity.secret))
  await page.getByRole('button', { name: 'Confirm change', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled()
  await page.getByRole('checkbox', { name: /I've saved these codes/ }).check()
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expectHome(page)
})

test('returning email requires TOTP and recovery leads through replacement before chat', async ({
  page,
}) => {
  const identity = await member(server.admin, page, 'Recovery owner', browserLogin)
  await expectHome(page)
  await signOut(page)
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0)
  await signin(page, identity)
  await signOut(page)
  const code = await sendEmail(page, identity.email)
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0)
  await page.getByLabel('Code', { exact: true }).fill(code)
  await page.getByRole('button', { name: 'Verify', exact: true }).click()
  await page.getByRole('button', { name: 'Use a recovery code', exact: true }).click()
  const recovery = identity.recovery[0]
  if (!recovery) throw new Error('No recovery code was issued during onboarding.')
  await page.getByLabel('Recovery code').fill(recovery)
  await page.getByRole('button', { name: 'Recover account', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Replace your authenticator' })).toBeVisible()
  const replacement = (await page.locator('.access-secret').textContent())?.trim()
  if (!replacement) throw new Error('No replacement authenticator key was displayed.')
  const { totp } = await import('./passwordless')
  await page.getByLabel('6-digit code').fill(totp(replacement))
  await page.getByRole('button', { name: 'Confirm and continue' }).click()
  await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toBeVisible()
  await page.getByRole('checkbox', { name: /I've saved these codes/ }).check()
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  const skip = page.getByRole('button', { name: 'Skip for now' })
  if (await skip.count()) await skip.click()
  await expectHome(page)
})

test('browser passkeys register, rename, sign in and remove with verified user presence', async ({
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
    const identity = await member(server.admin, page, 'Passkey owner', browserLogin)
    await page.getByRole('button', { name: 'Account security', exact: true }).click()
    await page.getByRole('button', { name: '+ Add passkey', exact: true }).click()
    await page.getByLabel('Passkey name').fill('Verified browser key')
    await page.getByLabel('Authenticator code').fill(await nextTotp(identity.secret))
    await page.getByRole('button', { name: 'Confirm change', exact: true }).click()
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
  } finally {
    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId })
    await cdp.detach()
  }
})
