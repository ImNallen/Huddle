import { expect, test, type Page } from '@playwright/test'
import { Account, Channel, Room } from '../packages/contracts/src/index'
import { actAs, browserApp, railTile, onboard, serverURL } from './accounts'
import { Client } from '../apps/server/scripts/harness'
import { useScratchServer } from './server'

useScratchServer('ui')
const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings', exact: true })
async function capture(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready)
  const path = test.info().outputPath(`${name}.png`)
  await page.screenshot({ path, animations: 'disabled' })
  await test.info().attach(name, { path, contentType: 'image/png' })
}

test('Settings matches both themes, uses actual mascot shapes and preserves profile and appearance controls', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await onboard(page, 'uiadmin', 'Our place')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(settings(page).locator('.settings-server')).toContainText('Our place')
  await page.keyboard.press('Escape')
  const admin = new Client(serverURL, 'uiadmin@huddle.test')
  await admin.stage()
  await admin.act({
    kind: 'profile.save',
    profile: { name: 'Adam Nilsson', avatar: { kind: 'mascot', shape: 'square', color: 'indigo' } },
  })
  const room = Room.parse((await admin.call('/api/rooms', { name: 'The studio' })).value)
  Channel.parse(
    (await admin.call('/api/channels', { roomId: room.id, name: 'general', kind: 'text' })).value,
  )
  await actAs(page, 'uiadmin')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.goto(browserApp)
  await railTile(page, 'The studio').click()
  const composer = page.getByRole('textbox', { name: 'Message #general', exact: true })
  await composer.fill('Keep this draft while Settings is open.')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = settings(page)
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('Adam Nilsson')
  expect(await dialog.boundingBox()).toMatchObject({ x: 220, y: 80, width: 1000, height: 740 })
  await expect(dialog.locator('.settings-side')).toHaveCSS('width', '200px')
  await expect(dialog.locator('.settings-bar h1')).toHaveCSS('font-size', '24px')
  await expect(dialog.locator('.settings-server .huddle-logo')).toHaveCSS('width', '24px')
  for (const shape of ['circle', 'square', 'bean', 'hexagon', 'triangle', 'flower']) {
    const choice = dialog.getByRole('button', { name: shape, exact: true })
    await expect(choice.getByRole('img')).toHaveCSS('width', '28px')
    await expect(choice.getByRole('img')).toHaveCSS('height', '28px')
    await expect(choice).toHaveCSS('width', '40px')
  }
  await expect(dialog.locator('.access-avatar-stage > .access-avatar')).toHaveCSS('width', '72px')
  await expect(dialog.locator('.access-preview > .access-avatar')).toHaveCSS('width', '36px')
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await capture(page, `settings-profile-${colorScheme}`)
  }
  await dialog.getByRole('button', { name: 'triangle', exact: true }).click()
  await dialog.getByRole('button', { name: 'teal', exact: true }).click()
  await expect(
    dialog.locator('.access-preview').getByRole('img', { name: 'teal triangle mascot' }),
  ).toBeVisible()
  await dialog.getByRole('button', { name: 'Save profile', exact: true }).click()
  await expect
    .poll(async () => Account.parse((await admin.call('/api/account')).value).user.avatar)
    .toEqual({ kind: 'mascot', shape: 'triangle', color: 'teal' })
  await dialog.getByRole('button', { name: 'Appearance', exact: true }).click()
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await expect(dialog.getByRole('radio', { name: 'System', exact: true })).toBeChecked()
    await expect(dialog.locator('.scheme-label .lucide-check')).toHaveCount(1)
    await expect(dialog.locator('.theme-card')).toHaveCount(6)
    await expect(dialog.locator('.theme-swatch-badge:visible')).toHaveCount(2)
    for (const swatch of await dialog.locator('.theme-swatch').all()) {
      const box = await swatch.boundingBox()
      expect(box?.width).toBe(box?.height)
    }
    const orbs = dialog.locator('.theme-orb input')
    await expect(orbs).toHaveCount(12)
    for (const orb of await orbs.all()) {
      await expect(orb).toHaveCSS('width', '40px')
      await expect(orb).toHaveCSS('height', '40px')
      expect(await orb.evaluate((element) => getComputedStyle(element).backgroundImage)).toContain(
        'url(',
      )
    }
    await capture(page, `settings-appearance-${colorScheme}`)
  }
  await dialog.getByRole('radio', { name: 'Dark', exact: true }).check()
  await expect(dialog.getByRole('radio', { name: 'Dark', exact: true })).toBeChecked()
  await dialog.getByRole('button', { name: 'Create theme', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Create theme', exact: true })).toBeVisible()
  await page
    .getByRole('dialog', { name: 'Create theme', exact: true })
    .getByRole('button', { name: 'Cancel', exact: true })
    .click()
  await dialog.getByRole('radio', { name: 'System', exact: true }).check()
  await dialog.getByRole('button', { name: 'Connection', exact: true }).click()
  await expect(dialog.getByText('Connected through Tailscale', { exact: true })).toBeVisible()
  await expect(dialog.getByText('uiadmin@huddle.test', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: /sign out/i })).toHaveCount(0)
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await capture(page, `settings-connection-${colorScheme}`)
  }
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(composer).toHaveValue('Keep this draft while Settings is open.')
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeFocused()
  await page.reload()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(
    settings(page).getByRole('button', { name: 'triangle', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')
  await expect(settings(page).getByRole('button', { name: 'teal', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 540, height: 740 })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await settings(page)
    .getByRole('button', { name: 'Save profile', exact: true })
    .scrollIntoViewIfNeeded()
  await expect(
    settings(page).getByRole('button', { name: 'Save profile', exact: true }),
  ).toBeInViewport()
  await expect(
    settings(page).getByRole('button', { name: 'Close settings', exact: true }),
  ).toBeInViewport()
  await page.setViewportSize({ width: 640, height: 740 })
  await settings(page).getByRole('button', { name: 'Appearance', exact: true }).click()
  for (const card of await settings(page).locator('.theme-card').all()) {
    const box = await card.boundingBox()
    if (!box) throw new Error('Theme card is missing')
    for (const orb of await card.locator('.theme-orb').all()) {
      const swatch = await orb.boundingBox()
      if (!swatch) throw new Error('Theme swatch is missing')
      expect(swatch.x).toBeGreaterThanOrEqual(box.x)
      expect(swatch.x + swatch.width).toBeLessThanOrEqual(box.x + box.width)
    }
  }
})
