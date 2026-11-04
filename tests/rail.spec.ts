import { expect, test } from '@playwright/test'
import { onboard, rail, railTile } from './accounts'
import { useScratchServer } from './server'

useScratchServer('ui')

test('the rail scrolls with many rooms, the last tile is reachable, and tooltips are not clipped', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1240, height: 600 })
  await onboard(page, 'railadmin', 'Crowded')
  const names = Array.from({ length: 30 }, (_, index) => `Room ${String(index).padStart(2, '0')}`)
  await page.evaluate(async (names) => {
    for (const name of names) {
      const response = await fetch('/api/rooms', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!response.ok) throw new Error(`Could not create ${name}.`)
    }
  }, names)
  const last = railTile(page, 'Room 29')
  await expect(last).toBeAttached()

  const scrolls = await rail(page).evaluate((nav) => nav.scrollHeight > nav.clientHeight)
  expect(scrolls).toBe(true)
  const barWidth = await rail(page).evaluate((nav) => nav.offsetWidth - nav.clientWidth)
  expect(barWidth).toBe(0)

  const lastTile = rail(page).getByRole('button').last()
  await lastTile.scrollIntoViewIfNeeded()
  await expect(lastTile).toBeInViewport({ ratio: 1 })
  const tile = await lastTile.boundingBox()
  const panel = await page.locator('.account').boundingBox()
  if (!tile || !panel) throw new Error('The last tile or the account panel is not on screen.')
  expect(tile.y + tile.height).toBeLessThanOrEqual(panel.y)

  await last.hover()
  const tip = page.locator('.rail-tooltip')
  await expect(tip).toHaveText('Room 29')
  await expect(tip).toHaveCSS('opacity', '1')
  await expect(tip).toBeInViewport({ ratio: 1 })
  const navBox = await rail(page).boundingBox()
  const tipBox = await tip.boundingBox()
  if (!navBox || !tipBox) throw new Error('The rail or its tooltip is not on screen.')
  expect(tipBox.x + tipBox.width).toBeGreaterThan(navBox.x + navBox.width)

  await page.mouse.move(640, 400)
  await expect(tip).toHaveCSS('opacity', '0')
  await rail(page).evaluate((nav) => nav.scrollTo({ top: 0 }))
  await expect(last).not.toBeInViewport()
  await page.keyboard.press('Shift')
  await last.focus()
  await expect(last).toBeInViewport({ ratio: 1 })
  await expect(tip).toHaveText('Room 29')
  await expect(tip).toHaveCSS('opacity', '1')
  await expect
    .poll(async () => {
      const [tileBox, hintBox] = await Promise.all([last.boundingBox(), tip.boundingBox()])
      if (!tileBox || !hintBox) throw new Error('The tile or its tooltip is not on screen.')
      return Math.abs(tileBox.y + tileBox.height / 2 - (hintBox.y + hintBox.height / 2))
    })
    .toBeLessThanOrEqual(1)
  await last.blur()

  await last.click()
  await expect(page.getByRole('heading', { name: 'Room 29 has no channels yet' })).toBeVisible()
  await expect(last).toHaveAttribute('aria-current', 'true')
})
