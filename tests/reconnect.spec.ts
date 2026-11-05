import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { Channel, Room } from '../packages/contracts/src/index'
import { browserApp, member, railTile } from './accounts'
import { useScratchServer } from './server'

const server = useScratchServer('api', { SOCKET_MAX_AGE_SECONDS: '2' })

test('a socket that ages out reconnects with no visible change', async ({ page }) => {
  const room = Room.parse((await server.admin.call('/api/rooms', { name: 'Steady' })).value)
  const channel = Channel.parse(
    (
      await server.admin.call('/api/channels', {
        roomId: room.id,
        name: 'general',
        kind: 'text',
      })
    ).value,
  )
  let sockets = 0
  page.on('websocket', () => (sockets += 1))
  await member(server.admin, page, 'steady', browserApp)
  await railTile(page, 'Steady').click()
  const status = page.locator('.account').getByRole('status')
  await expect(status).toHaveText('Connected')
  await status.evaluate((element) => {
    const seen: (string | null)[] = []
    Object.assign(window, { seenStatuses: seen })
    new MutationObserver(() => seen.push(element.textContent)).observe(element, {
      characterData: true,
      childList: true,
      subtree: true,
    })
  })
  await expect.poll(() => sockets, { timeout: 15000 }).toBeGreaterThanOrEqual(3)
  const body = `sent after two reconnects ${randomUUID()}`
  await server.admin.call('/api/messages', { retryId: randomUUID(), channelId: channel.id, body })
  await expect(page.getByText(body, { exact: true })).toBeVisible()
  expect(
    await page.evaluate(() => (window as unknown as { seenStatuses: string[] }).seenStatuses),
  ).toEqual([])
})
