import { expect, test, type Page } from '@playwright/test'
import { Room } from '../packages/contracts/src/index'
import { runningLivekit } from '../apps/server/scripts/harness'
import { browserApp, member, railTile } from './accounts'
import { useScratchServer } from './server'
import {
  fakeMicrophoneLaunch,
  watchCalls,
  openMicrophones,
  openPeers,
  expectHearing,
  expectSilence,
  playingSounds,
} from './voice'

const server = useScratchServer('api')
test.beforeAll(() => runningLivekit())
test.use({ launchOptions: fakeMicrophoneLaunch, actionTimeout: 10000 })
const notice = (page: Page) => page.getByRole('region', { name: 'Private call', exact: true })
async function openDirect(page: Page, peer: string) {
  await page.reload()
  await railTile(page, 'Home').click()
  if ((page.viewportSize()?.width ?? 1280) < 640) {
    await page.getByRole('button', { name: 'New message', exact: true }).click()
    await page
      .getByRole('dialog', { name: 'New message', exact: true })
      .getByRole('option', { name: peer, exact: true })
      .click()
    await expect(page.getByRole('textbox', { name: `Message @${peer}`, exact: true })).toBeVisible()
    return
  }
  await page.getByRole('button', { name: 'Member list', exact: true }).click()
  await page
    .getByRole('list', { name: 'Members', exact: true })
    .getByRole('button', { name: `View ${peer}`, exact: true })
    .click()
  await page
    .getByRole('dialog', { name: peer, exact: true })
    .getByRole('button', { name: `Message ${peer}`, exact: true })
    .click()
  await expect(page.getByRole('textbox', { name: `Message @${peer}`, exact: true })).toBeVisible()
}
async function expectClosed(page: Page) {
  await expect.poll(() => openMicrophones(page)).toBe(0)
  await expect.poll(() => openPeers(page)).toBe(0)
  await expect.poll(() => playingSounds(page)).toBe(0)
}

test('private calls require acceptance, stay in the consenting windows, carry real audio and clean up', async ({
  browser,
}) => {
  const a = await browser.newContext(),
    b = await browser.newContext(),
    c = await browser.newContext()
  await Promise.all([watchCalls(a), watchCalls(b), watchCalls(c)])
  const alice = await a.newPage(),
    bob = await b.newPage(),
    outsider = await c.newPage()
  try {
    await member(server.admin, alice, 'callalice', browserApp)
    await member(server.admin, bob, 'callbob', browserApp)
    await member(server.admin, outsider, 'calloutsider', browserApp)
    await openDirect(alice, 'callbob')
    const draft = alice.getByRole('textbox', { name: 'Message @callbob', exact: true })
    await draft.fill('Keep this draft')
    const otherA = await a.newPage(),
      otherB = await b.newPage()
    await otherA.goto(browserApp)
    await otherB.goto(browserApp)
    await alice.getByRole('button', { name: 'Call', exact: true }).click()
    await expect(notice(bob).getByRole('button', { name: 'Accept', exact: true })).toBeVisible()
    for (const page of [alice, bob, otherA, otherB, outsider])
      expect(await openMicrophones(page)).toBe(0)
    await expect(notice(outsider)).toHaveCount(0)
    await notice(bob).getByRole('button', { name: 'Decline', exact: true }).click()
    await expect(notice(alice)).toContainText('Call declined.')
    await notice(alice).getByRole('button', { name: 'Dismiss', exact: true }).click()
    await alice.getByRole('button', { name: 'Call', exact: true }).click()
    await expect(notice(bob).getByRole('button', { name: 'Accept', exact: true })).toBeVisible()
    await notice(alice).getByRole('button', { name: 'Cancel call', exact: true }).click()
    await expect(notice(bob)).toContainText('Call cancelled.')
    expect(await openMicrophones(bob)).toBe(0)
    await alice.getByRole('button', { name: 'Call', exact: true }).click()
    await expect(notice(bob).getByRole('button', { name: 'Accept', exact: true })).toBeVisible()
    await notice(bob).getByRole('button', { name: 'Accept', exact: true }).click()
    await expect(notice(alice).getByRole('status')).toHaveText('Voice connected', {
      timeout: 40000,
    })
    await expect(notice(bob).getByRole('status')).toHaveText('Voice connected', { timeout: 40000 })
    await expectHearing(alice)
    await expectHearing(bob)
    expect(await openMicrophones(otherA)).toBe(0)
    expect(await openMicrophones(otherB)).toBe(0)
    await expect(notice(otherB)).toContainText('Answered in another window.')
    await notice(bob)
      .getByRole('button', { name: /callalice/ })
      .click()
    await expect(
      bob.getByRole('textbox', { name: 'Message @callalice', exact: true }),
    ).toBeVisible()
    await expect(draft).toHaveValue('Keep this draft')
    await notice(alice).getByRole('button', { name: 'Mute', exact: true }).click()
    await expectSilence(bob)
    await notice(alice).getByRole('button', { name: 'Mute', exact: true }).click()
    await expectHearing(bob)
    await notice(bob).getByRole('button', { name: 'Deafen', exact: true }).click()
    await expectSilence(alice)
    await notice(bob).getByRole('button', { name: 'Deafen', exact: true }).click()
    await expectHearing(alice)
    await railTile(alice, 'Home').click()
    await expectHearing(alice)
    await notice(alice)
      .getByRole('button', { name: /callbob/ })
      .click()
    await expect(draft).toHaveValue('Keep this draft')
    await notice(bob).getByRole('button', { name: 'Hang up', exact: true }).click()
    await expect(notice(alice)).toContainText('Call ended.')
    await expectClosed(alice)
    await expectClosed(bob)
    await expect(draft).toHaveValue('Keep this draft')
    await expect(notice(outsider)).toHaveCount(0)
  } finally {
    await a.close()
    await b.close()
    await c.close()
  }
})

test('mobile private call controls and reload never resume the microphone', async ({ browser }) => {
  const a = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    }),
    b = await browser.newContext()
  await watchCalls(a)
  await watchCalls(b)
  const alice = await a.newPage(),
    bob = await b.newPage()
  try {
    const room = Room.parse(
      (await server.admin.call('/api/rooms', { name: 'Mobile private calls' })).value,
    )
    await server.admin.call('/api/channels', { roomId: room.id, name: 'chat', kind: 'text' })
    await member(server.admin, alice, 'mobilecaller', browserApp)
    await member(server.admin, bob, 'mobilerecipient', browserApp)
    await openDirect(alice, 'mobilerecipient')
    await alice.getByRole('button', { name: 'Call', exact: true }).click()
    await notice(bob).getByRole('button', { name: 'Accept', exact: true }).click()
    await expect(notice(alice).getByRole('status').first()).toHaveText('Voice connected', {
      timeout: 40000,
    })
    await expectHearing(alice)
    const composer = alice.getByRole('textbox', { name: 'Message @mobilerecipient', exact: true })
    await composer.click()
    await composer.fill('A draft during a private call')
    await expect(composer).toHaveValue('A draft during a private call')
    for (const name of ['Mute', 'Deafen', 'Leave']) {
      const box = await notice(alice).getByRole('button', { name, exact: true }).boundingBox()
      expect(box?.height).toBeGreaterThanOrEqual(64)
    }
    await alice.reload()
    await expect(railTile(alice, 'Home')).toBeVisible()
    expect(await openMicrophones(alice)).toBe(0)
    await expect(notice(bob)).toContainText('Call ended.')
    await expectClosed(alice)
    await expectClosed(bob)
  } finally {
    await a.close()
    await b.close()
  }
})

test('cancel survives a late start answer and a late microphone permission result is released', async ({
  browser,
}) => {
  const a = await browser.newContext(),
    b = await browser.newContext()
  await watchCalls(a)
  await watchCalls(b)
  const alice = await a.newPage(),
    bob = await b.newPage()
  let releaseStart = () => {}
  try {
    await member(server.admin, alice, 'latecaller', browserApp)
    await member(server.admin, bob, 'laterecipient', browserApp)
    await openDirect(alice, 'laterecipient')
    const held = new Promise<void>((resolve) => {
      releaseStart = resolve
    })
    await alice.route('**/api/direct/calls/start', async (route) => {
      const response = await route.fetch()
      await held
      await route.fulfill({ response })
    })
    await alice.getByRole('button', { name: 'Call', exact: true }).click()
    await expect(notice(bob).getByRole('button', { name: 'Accept', exact: true })).toBeVisible()
    await notice(alice).getByRole('button', { name: 'Cancel call', exact: true }).click()
    await expect(notice(bob)).toContainText('Call cancelled.')
    releaseStart()
    await expect(notice(alice)).toContainText('Call cancelled.')
    await alice.unroute('**/api/direct/calls/start')
    expect(await openMicrophones(alice)).toBe(0)
    await alice.evaluate(() => {
      const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      const permission = new Promise<void>((resolve) =>
        window.addEventListener('release-call-permission', () => resolve(), { once: true }),
      )
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        await permission
        return capture(constraints)
      }
    })
    await alice.getByRole('button', { name: 'Call', exact: true }).click()
    await notice(bob).getByRole('button', { name: 'Accept', exact: true }).click()
    await expect(notice(alice)).toContainText('Waiting for microphone')
    await notice(alice).getByRole('button', { name: 'Hang up', exact: true }).click()
    await expect(notice(bob)).toContainText('Call ended.')
    await alice.evaluate(() => window.dispatchEvent(new Event('release-call-permission')))
    await expect
      .poll(() => alice.evaluate(() => window.probe.microphones.length))
      .toBeGreaterThan(0)
    await expectClosed(alice)
    await expectClosed(bob)
    await expect(notice(alice)).toContainText('Call ended.')
  } finally {
    releaseStart()
    await a.close()
    await b.close()
  }
})

test('a private call can be declined during a room call or explicitly replace it on answer', async ({
  browser,
}) => {
  const a = await browser.newContext(),
    b = await browser.newContext()
  await watchCalls(a)
  await watchCalls(b)
  const alice = await a.newPage(),
    bob = await b.newPage()
  try {
    const room = Room.parse(
      (await server.admin.call('/api/rooms', { name: 'Answer from a room' })).value,
    )
    await server.admin.call('/api/channels', { roomId: room.id, name: 'chat', kind: 'text' })
    await server.admin.call('/api/channels', { roomId: room.id, name: 'lounge', kind: 'voice' })
    await member(server.admin, alice, 'roomcaller', browserApp)
    await member(server.admin, bob, 'roomrecipient', browserApp)
    await railTile(bob, room.name).click()
    await bob
      .getByRole('navigation', { name: `${room.name} channels`, exact: true })
      .getByRole('button', { name: 'lounge', exact: true })
      .click()
    await bob.getByRole('main').getByRole('button', { name: 'Join voice', exact: true }).click()
    const roomPanel = bob.getByRole('region', { name: 'Call', exact: true })
    await expect(roomPanel.getByRole('status')).toHaveText('Voice connected', { timeout: 40000 })
    await openDirect(alice, 'roomrecipient')
    await alice.getByRole('button', { name: 'Call', exact: true }).click()
    await expect(
      notice(bob).getByRole('button', { name: 'Leave and answer', exact: true }),
    ).toBeVisible()
    await notice(bob).getByRole('button', { name: 'Decline', exact: true }).click()
    await expect(roomPanel.getByRole('status')).toHaveText('Voice connected')
    expect(await openMicrophones(bob)).toBe(1)
    await expect(notice(alice)).toContainText('Call declined.')
    await alice.getByRole('button', { name: 'Call', exact: true }).click()
    await notice(bob).getByRole('button', { name: 'Leave and answer', exact: true }).click()
    await expect(notice(bob).getByRole('status')).toHaveText('Voice connected', { timeout: 40000 })
    await expect(roomPanel).toHaveCount(0)
    await expectHearing(alice)
    await expectHearing(bob)
    await notice(bob).getByRole('button', { name: 'Hang up', exact: true }).click()
    await expectClosed(alice)
    await expectClosed(bob)
  } finally {
    await a.close()
    await b.close()
  }
})
