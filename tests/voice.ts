import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { Channel, Room } from '../packages/contracts/src/index'
import { browserApp, member } from './accounts'
import type { useScratchServer } from './server'

export const fakeMicrophone = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
]
export const fakeMicrophoneLaunch = {
  args: ['--disable-features=LocalNetworkAccessChecks', ...fakeMicrophone],
  ...(process.env.PLAYWRIGHT_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE }
    : {}),
}

type Probe = {
  peers: RTCPeerConnection[]
  microphones: MediaStreamTrack[]
}
declare global {
  interface Window {
    probe: Probe
  }
}
/** Watches the browser's real WebRTC objects. The app has no test mode to ask. */
export async function watchCalls(context: BrowserContext) {
  await context.addInitScript(() => {
    const probe: Probe = { peers: [], microphones: [] }
    window.probe = probe
    const Native = window.RTCPeerConnection
    window.RTCPeerConnection = class extends Native {
      constructor(...args: ConstructorParameters<typeof Native>) {
        super(...args)
        probe.peers.push(this)
      }
    }
    const devices = navigator.mediaDevices
    const capture = devices.getUserMedia.bind(devices)
    devices.getUserMedia = async (constraints) => {
      const stream = await capture(constraints)
      probe.microphones.push(...stream.getAudioTracks())
      return stream
    }
  })
}
/** Audio energy received so far on this page's open connections. */
export const energy = (page: Page) =>
  page.evaluate(async () => {
    let total = 0
    for (const peer of window.probe.peers) {
      if (peer.connectionState === 'closed') continue
      const stats = await peer.getStats()
      stats.forEach((report: { type: string; kind?: string; totalAudioEnergy?: number }) => {
        if (report.type === 'inbound-rtp' && report.kind === 'audio')
          total += report.totalAudioEnergy ?? 0
      })
    }
    return total
  })
export async function expectHearing(page: Page) {
  const before = await energy(page)
  await expect
    .poll(async () => (await energy(page)) - before, { timeout: 20000 })
    .toBeGreaterThan(0)
}
export async function expectSilence(page: Page) {
  // Audio already on its way can still arrive just after a mute.
  await page.waitForTimeout(1500)
  const before = await energy(page)
  await page.waitForTimeout(2000)
  expect((await energy(page)) - before).toBe(0)
}
export const openMicrophones = (page: Page) =>
  page.evaluate(
    () => window.probe.microphones.filter((track) => track.readyState === 'live').length,
  )
export const openPeers = (page: Page) =>
  page.evaluate(() => window.probe.peers.filter((peer) => peer.connectionState !== 'closed').length)

/** Remote audio the page is really playing, not only receiving. */
export const playingSounds = (page: Page) =>
  page.evaluate(
    () =>
      [...document.querySelectorAll('audio')].filter((audio) => audio.srcObject && !audio.paused)
        .length,
  )

let roomNumber = 0
let personNumber = 0
export function voicePeople(server: ReturnType<typeof useScratchServer>) {
  return {
    async voiceRoom(...channelNames: string[]) {
      const room = Room.parse(
        (await server.admin.call('/api/rooms', { name: `Voice ${++roomNumber}` })).value,
      )
      await server.admin.call('/api/channels', { roomId: room.id, name: 'chat', kind: 'text' })
      for (const name of channelNames) {
        Channel.parse(
          (await server.admin.call('/api/channels', { roomId: room.id, name, kind: 'voice' }))
            .value,
        )
      }
      return room.name
    },
    async person(
      browser: Browser,
      name: string,
      roomName: string,
      path = browserApp,
      prepare?: (context: BrowserContext) => Promise<void>,
    ) {
      const context = await browser.newContext()
      await watchCalls(context)
      await prepare?.(context)
      const page = await context.newPage()
      await member(server.admin, page, `${name}${++personNumber}`, path)
      await openRoom(page, roomName)
      return { context, page, name: `${name}${personNumber}` }
    },
    nextPersonNumber: () => ++personNumber,
  }
}
export async function openRoom(page: Page, roomName: string) {
  await page
    .getByRole('navigation', { name: 'Rooms', exact: true })
    .getByRole('button', { name: roomName, exact: true })
    .click()
}
export const channelRow = (page: Page, roomName: string, name: string) =>
  page
    .getByRole('navigation', { name: `${roomName} channels`, exact: true })
    .getByRole('button', { name })
export const panel = (page: Page) => page.getByRole('region', { name: 'Call', exact: true })
export const main = (page: Page) => page.getByRole('main')
export const join = (page: Page) =>
  main(page).getByRole('button', { name: 'Join voice', exact: true })
export async function expectInCall(page: Page) {
  await expect(panel(page).getByRole('status')).toHaveText(
    /^(Voice connected|Microphone muted|Deafened)$/,
    { timeout: 40000 },
  )
}
export const inCallList = (page: Page) => main(page).getByRole('list', { name: 'In this call' })
export const inCallNames = (page: Page) => inCallList(page).locator('.call-person-name')
