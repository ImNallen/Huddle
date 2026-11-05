import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { Channel, Room } from '../packages/contracts/src/index'
import { member, railTile } from './accounts'
import { useScratchServer } from './server'

const server = useScratchServer('api')

test('the thread stays at its end while the layout changes and never yanks a reader', async ({
  page,
}) => {
  const room = Room.parse((await server.admin.call('/api/rooms', { name: 'History' })).value)
  const { value } = await server.admin.call('/api/channels', {
    roomId: room.id,
    name: 'long-history',
    kind: 'text',
  })
  const channel = Channel.parse(value)
  const post = (body: string) =>
    server.admin.call('/api/messages', { retryId: randomUUID(), channelId: channel.id, body })
  for (let index = 1; index <= 30; index++) await post(`History line ${index}`)

  await page.setViewportSize({ width: 1280, height: 640 })
  await member(server.admin, page, 'reader')
  await railTile(page, 'History').click()

  const thread = page.getByRole('main')
  const scroller = page.locator('.scroll')
  const composer = page.getByRole('textbox', { name: 'Message #long-history' })
  const last = thread.getByRole('article').last()
  await expect(last).toContainText('History line 30')
  await expect(last).toBeInViewport({ ratio: 1 })
  const gapAboveComposer = async () => {
    const [message, box] = await Promise.all([last.boundingBox(), composer.boundingBox()])
    if (!message || !box) throw new Error('The thread end is not on screen.')
    return Math.round(box.y - (message.y + message.height))
  }
  const restingGap = await gapAboveComposer()
  expect(restingGap).toBeGreaterThanOrEqual(24)
  const atEnd = () =>
    expect
      .poll(async () => Math.abs((await gapAboveComposer()) - restingGap))
      .toBeLessThanOrEqual(1)

  const singleLine = await composer.boundingBox()
  await composer.fill('one\ntwo\nthree\nfour\nfive\nsix')
  await expect
    .poll(async () => (await composer.boundingBox())?.height)
    .toBeGreaterThan(singleLine?.height ?? 0)
  await expect(last).toBeInViewport({ ratio: 1 })
  await atEnd()
  await composer.fill('')
  await atEnd()

  await post(
    `A long reply that wraps once the member list narrows the thread. ${'word '.repeat(60)}`,
  )
  await expect(last).toContainText('A long reply')
  await atEnd()
  await page.getByRole('button', { name: 'Member list', exact: true }).click()
  await atEnd()
  await page.getByRole('button', { name: 'Member list', exact: true }).click()
  await atEnd()

  await composer.fill('one\ntwo\nthree\nfour\nfive\nsix')
  await expect(last).toBeInViewport({ ratio: 1 })
  await composer.fill('')
  await page.setViewportSize({ width: 640, height: 480 })
  await atEnd()
  await page.setViewportSize({ width: 1280, height: 640 })
  await atEnd()

  await expect(async () => {
    await scroller.evaluate((view) => view.scrollTo({ top: 0 }))
    await expect(page.getByRole('heading', { name: 'Welcome to #long-history' })).toBeInViewport({
      timeout: 250,
    })
  }).toPass()
  await composer.fill('one\ntwo\nthree\nfour')
  await post('Arrives while someone reads history')
  await expect(last).toContainText('Arrives while someone reads history')
  await page.getByRole('button', { name: 'Member list', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Welcome to #long-history' })).toBeInViewport()
  await expect(scroller).toHaveJSProperty('scrollTop', 0)
  await expect(last).not.toBeInViewport()

  await composer.fill('Sending returns me to the end')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(last).toContainText('Sending returns me to the end')
  await expect(last).toBeInViewport({ ratio: 1 })
})
