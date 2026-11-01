import { expect, test, type Browser, type Page } from '@playwright/test'
import {
  browserLogin,
  expectHome,
  member,
  serverURL,
  signIn,
  signOut,
  type Identity,
} from './accounts'
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

async function signedInElsewhere(browser: Browser, identity: Identity) {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.addInitScript((origin) => localStorage.setItem('huddle.server', origin), serverURL)
  await page.goto(browserLogin)
  await signIn(page, identity.username, identity.password)
  return { context, page }
}
async function openSecurity(page: Page) {
  await page.getByRole('button', { name: 'Account security', exact: true }).click()
  return page.locator('section', { has: page.getByRole('heading', { name: 'Active sessions' }) })
}
const sessionRows = (page: Page) => page.getByText(/^Signed in .*\. Expires /)
const signInHeading = (page: Page) => page.getByRole('heading', { name: 'Sign in to Huddle UI' })

test('signing out one session ends only that session', async ({ page, browser }) => {
  const identity = await member(server.admin, page, 'one-session', browserLogin)
  const laptop = await signedInElsewhere(browser, identity)
  const phone = await signedInElsewhere(browser, identity)
  try {
    const sessions = await openSecurity(page)
    await expect(sessionRows(page)).toHaveCount(3)
    await expect(sessions.getByText(/· This device$/)).toBeVisible()
    await sessions.getByRole('button', { name: 'Sign out', exact: true }).first().click()
    await expect(sessionRows(page)).toHaveCount(2)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await laptop.page.reload()
    await expect(signInHeading(laptop.page)).toBeVisible()
    await phone.page.reload()
    await expectHome(phone.page)
    await page.reload()
    await expectHome(page)
  } finally {
    await laptop.context.close()
    await phone.context.close()
  }
})

test('signing out all other sessions keeps only this device', async ({ page, browser }) => {
  const identity = await member(server.admin, page, 'all-sessions', browserLogin)
  const laptop = await signedInElsewhere(browser, identity)
  const phone = await signedInElsewhere(browser, identity)
  try {
    const sessions = await openSecurity(page)
    await expect(sessionRows(page)).toHaveCount(3)
    await sessions.getByRole('button', { name: 'Sign out all other sessions', exact: true }).click()
    await expect(sessionRows(page)).toHaveCount(1)
    await expect(sessions.getByText(/· This device$/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign out all other sessions' })).toHaveCount(0)
    for (const other of [laptop.page, phone.page]) {
      await other.reload()
      await expect(signInHeading(other)).toBeVisible()
    }
    await page.reload()
    await expectHome(page)
  } finally {
    await laptop.context.close()
    await phone.context.close()
  }
})

test('changing the password signs out other sessions and the new one signs in', async ({
  page,
  browser,
}) => {
  const identity = await member(server.admin, page, 'new-password', browserLogin)
  const laptop = await signedInElsewhere(browser, identity)
  try {
    await openSecurity(page)
    await expect(sessionRows(page)).toHaveCount(2)
    const form = page.locator('section', {
      has: page.getByRole('heading', { name: 'Change password' }),
    })
    const change = async (current: string, next: string, confirm = next) => {
      await form.getByLabel('Current password').fill(current)
      await form.getByLabel('New password', { exact: true }).fill(next)
      await form.getByLabel('Confirm new password').fill(confirm)
      await form.getByRole('button', { name: 'Change password', exact: true }).click()
    }
    await change(identity.password, 'brand-new-secret', 'brand-new-typo')
    await expect(form.getByRole('alert')).toHaveText('The new passwords don’t match.')
    await change('not-the-password', 'brand-new-secret')
    await expect(form.getByRole('alert')).toHaveText('Your current password is incorrect.')
    await laptop.page.reload()
    await expectHome(laptop.page)

    await change(identity.password, 'brand-new-secret')
    await expect(form.getByRole('status')).toHaveText(
      'Password changed. Your other sessions were signed out.',
    )
    await expect(form.getByLabel('Current password')).toHaveValue('')
    await expect(sessionRows(page)).toHaveCount(1)
    await laptop.page.reload()
    await expect(signInHeading(laptop.page)).toBeVisible()

    await page.reload()
    await expectHome(page)
    await signOut(page)
    const signInForm = page.locator('form').filter({
      has: page.getByRole('button', { name: 'Sign in', exact: true }),
    })
    await signInForm.getByLabel('Username').fill(identity.username)
    await signInForm.getByLabel('Password').fill(identity.password)
    await signInForm.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText(
      "That username or password isn't right. Check both and try again.",
    )
    await signIn(page, identity.username, 'brand-new-secret')
  } finally {
    await laptop.context.close()
  }
})
