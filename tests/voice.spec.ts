import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { Channel, Room } from '../packages/contracts/src/index'
import { runningLivekit, tailscale } from '../apps/server/scripts/harness'
import { browserApp, loginOf, member, serverURL } from './accounts'
import { useScratchServer } from './server'

const server = useScratchServer('api')
test.beforeAll(() => runningLivekit())
const fakeMicrophone = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
test.use({
  launchOptions: {
    args: ['--disable-features=LocalNetworkAccessChecks', ...fakeMicrophone],
    ...(process.env.PLAYWRIGHT_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE }
      : {}),
  },
})

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
async function watchCalls(context: BrowserContext) {
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
const energy = (page: Page) =>
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
async function expectHearing(page: Page) {
  const before = await energy(page)
  await expect
    .poll(async () => (await energy(page)) - before, { timeout: 20000 })
    .toBeGreaterThan(0)
}
async function expectSilence(page: Page) {
  // Audio already on its way can still arrive just after a mute.
  await page.waitForTimeout(1500)
  const before = await energy(page)
  await page.waitForTimeout(2000)
  expect((await energy(page)) - before).toBe(0)
}
const openMicrophones = (page: Page) =>
  page.evaluate(
    () => window.probe.microphones.filter((track) => track.readyState === 'live').length,
  )
const openPeers = (page: Page) =>
  page.evaluate(() => window.probe.peers.filter((peer) => peer.connectionState !== 'closed').length)

/** Remote audio the page is really playing, not only receiving. */
const playingSounds = (page: Page) =>
  page.evaluate(
    () =>
      [...document.querySelectorAll('audio')].filter((audio) => audio.srcObject && !audio.paused)
        .length,
  )

let roomNumber = 0
async function voiceRoom(...channelNames: string[]) {
  const room = Room.parse(
    (await server.admin.call('/api/rooms', { name: `Voice ${++roomNumber}` })).value,
  )
  await server.admin.call('/api/channels', { roomId: room.id, name: 'chat', kind: 'text' })
  for (const name of channelNames) {
    Channel.parse(
      (await server.admin.call('/api/channels', { roomId: room.id, name, kind: 'voice' })).value,
    )
  }
  return room.name
}
let personNumber = 0
async function person(browser: Browser, name: string, roomName: string, path = browserApp) {
  const context = await browser.newContext()
  await watchCalls(context)
  const page = await context.newPage()
  await member(server.admin, page, `${name}${++personNumber}`, path)
  await openRoom(page, roomName)
  return { context, page, name: `${name}${personNumber}` }
}
async function openRoom(page: Page, roomName: string) {
  await page
    .getByRole('navigation', { name: 'Rooms', exact: true })
    .getByRole('button', { name: roomName, exact: true })
    .click()
}
const channelRow = (page: Page, roomName: string, name: string) =>
  page
    .getByRole('navigation', { name: `${roomName} channels`, exact: true })
    .getByRole('button', { name })
const panel = (page: Page) => page.getByRole('region', { name: 'Call', exact: true })
const main = (page: Page) => page.getByRole('main')
const join = (page: Page) => main(page).getByRole('button', { name: 'Join voice', exact: true })
async function expectInCall(page: Page) {
  await expect(panel(page).getByRole('status')).toHaveText('Voice connected', { timeout: 40000 })
}
const inCallList = (page: Page) => main(page).getByRole('list', { name: 'In this call' })
const inCallNames = (page: Page) => inCallList(page).locator('.call-person-name')

test('two people on different builds hear each other, mute, keep talking elsewhere, and leave', async ({
  browser,
}) => {
  const roomName = await voiceRoom('hangout')
  // One person on the server's production build, the other on the desktop frontend in a browser.
  const ada = await person(browser, 'ada', roomName)
  const bo = await person(browser, 'bo', roomName, '/')
  try {
    const chunks: string[] = []
    ada.page.on('request', (request) => chunks.push(request.url()))
    await channelRow(ada.page, roomName, 'hangout').click()
    await expect(main(ada.page).getByText('Nobody hears you until you join.')).toBeVisible()
    expect(chunks.filter((url) => /livekit/i.test(url))).toEqual([])
    expect(await ada.page.evaluate(() => window.probe.microphones.length)).toBe(0)

    await join(ada.page).click()
    await expectInCall(ada.page)
    await expect(main(ada.page).getByText("You're the only one here.")).toBeVisible()
    // The one button changes role in place, so a keyboard user keeps their spot.
    await expect(
      main(ada.page).getByRole('button', { name: 'Leave call', exact: true }),
    ).toBeFocused()
    await expect(inCallNames(ada.page)).toHaveText([ada.name])

    await channelRow(bo.page, roomName, 'hangout').click()
    await join(bo.page).click()
    await expectInCall(bo.page)
    await expect(main(bo.page).getByText('2 people in this call.')).toBeVisible()
    await expect(inCallNames(bo.page)).toHaveText([bo.name, ada.name])
    await expect(inCallNames(ada.page)).toHaveText([ada.name, bo.name])
    await expectHearing(ada.page)
    await expectHearing(bo.page)
    await expect.poll(() => playingSounds(ada.page)).toBe(1)
    await expect.poll(() => playingSounds(bo.page)).toBe(1)

    const mute = panel(ada.page).getByRole('button', { name: 'Mute', exact: true })
    await expect(mute).toHaveAttribute('aria-pressed', 'false')
    await mute.click()
    await expect(mute).toHaveAttribute('aria-pressed', 'true')
    await expect(inCallList(bo.page).getByRole('listitem').nth(1)).toContainText('muted')
    await expectSilence(bo.page)
    await expectHearing(ada.page)
    await mute.click()
    await expect(inCallList(bo.page).getByRole('listitem').nth(1)).not.toContainText('muted')
    await expectHearing(bo.page)

    await channelRow(ada.page, roomName, 'chat').click()
    await expect(ada.page.getByRole('heading', { name: 'Welcome to #chat' })).toBeVisible()
    await expect(panel(ada.page).getByRole('status')).toHaveText('Voice connected')
    await expectHearing(ada.page)
    await expectHearing(bo.page)
    await panel(ada.page)
      .getByRole('button', { name: /hangout/ })
      .click()
    await expect(inCallNames(ada.page)).toHaveText([ada.name, bo.name])

    await main(ada.page).getByRole('button', { name: 'Leave call', exact: true }).click()
    await expect(panel(ada.page)).toHaveCount(0)
    await expect(join(ada.page)).toBeVisible()
    await expect.poll(() => openMicrophones(ada.page)).toBe(0)
    await expect.poll(() => openPeers(ada.page)).toBe(0)
    await expect.poll(() => playingSounds(ada.page)).toBe(0)
    await expect(main(bo.page).getByText("You're the only one here.")).toBeVisible()
    await expect.poll(() => playingSounds(bo.page)).toBe(0)

    await panel(bo.page).getByRole('button', { name: 'Leave call', exact: true }).click()
    await expect.poll(() => openMicrophones(bo.page)).toBe(0)
  } finally {
    await ada.context.close()
    await bo.context.close()
  }
})

test('joining another channel leaves the first and a muted person stays muted', async ({
  browser,
}) => {
  const roomName = await voiceRoom('north', 'south')
  const ada = await person(browser, 'ada', roomName)
  try {
    await channelRow(ada.page, roomName, 'north').click()
    await join(ada.page).click()
    await expectInCall(ada.page)
    await expect(channelRow(ada.page, roomName, 'north')).toHaveAccessibleName(
      /you're in this call/,
    )
    await panel(ada.page).getByRole('button', { name: 'Mute', exact: true }).click()

    await channelRow(ada.page, roomName, 'south').click()
    await expect(main(ada.page).getByText('Joining here takes you out of north.')).toBeVisible()
    await join(ada.page).click()
    await expect(panel(ada.page).getByText('south')).toBeVisible()
    await expectInCall(ada.page)
    await expect(channelRow(ada.page, roomName, 'north')).not.toHaveAccessibleName(/in this call/)
    await expect(channelRow(ada.page, roomName, 'south')).toHaveAccessibleName(
      /you're in this call/,
    )
    await expect(
      panel(ada.page).getByRole('button', { name: 'Mute', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => openMicrophones(ada.page)).toBe(1)
    await expect.poll(() => openPeers(ada.page)).toBe(1)
  } finally {
    await ada.context.close()
  }
})

test('cancelling while the browser waits on the microphone releases it when it finally arrives', async ({
  browser,
}) => {
  const roomName = await voiceRoom('patient')
  const ada = await person(browser, 'ada', roomName)
  try {
    const tokens: string[] = []
    ada.page.on('request', (request) => {
      if (request.url().includes('/api/voice/token')) tokens.push(request.url())
    })
    await ada.page.evaluate(() => {
      const devices = navigator.mediaDevices
      const capture = devices.getUserMedia.bind(devices)
      devices.getUserMedia = async (constraints) => {
        await new Promise((resolve) => Object.assign(window, { answerPrompt: resolve }))
        return capture(constraints)
      }
    })
    await channelRow(ada.page, roomName, 'patient').click()
    await join(ada.page).click()
    await expect(
      main(ada.page).getByText('Waiting for your microphone.', { exact: false }),
    ).toBeVisible()
    await expect(panel(ada.page).getByRole('status')).toHaveText('Waiting for microphone')
    await main(ada.page).getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(join(ada.page)).toBeVisible()
    await ada.page.waitForFunction(() => 'answerPrompt' in window)
    await ada.page.evaluate(() =>
      (window as unknown as { answerPrompt: () => void }).answerPrompt(),
    )
    await expect.poll(() => ada.page.evaluate(() => window.probe.microphones.length)).toBe(1)
    await expect.poll(() => openMicrophones(ada.page)).toBe(0)
    expect(tokens).toEqual([])
    await expect(panel(ada.page)).toHaveCount(0)
  } finally {
    await ada.context.close()
  }
})

test('a microphone that will not start says why and Try again recovers', async ({ browser }) => {
  const roomName = await voiceRoom('quiet')
  const ada = await person(browser, 'ada', roomName)
  try {
    await ada.page.evaluate(() => {
      const devices = navigator.mediaDevices
      const capture = devices.getUserMedia
      Object.assign(window, { restoreMicrophone: () => (devices.getUserMedia = capture) })
    })
    await channelRow(ada.page, roomName, 'quiet').click()
    const cases: [string, string][] = [
      ['NotAllowedError', "Huddle can't use your microphone."],
      ['NotFoundError', "Huddle can't find a microphone."],
      ['NotReadableError', "Your microphone isn't responding."],
      ['AbortError', "Your microphone didn't start."],
    ]
    for (const [name, message] of cases) {
      await ada.page.evaluate((name) => {
        navigator.mediaDevices.getUserMedia = () =>
          Promise.reject(new DOMException('refused', name))
      }, name)
      const start = main(ada.page).getByRole('button', { name: /^(Join voice|Try again)$/ })
      await start.click()
      await expect(main(ada.page).getByRole('alert')).toContainText(message)
      await expect(panel(ada.page)).toHaveCount(0)
    }
    await ada.page.evaluate(() =>
      (window as unknown as { restoreMicrophone: () => void }).restoreMicrophone(),
    )
    await main(ada.page).getByRole('button', { name: 'Try again', exact: true }).click()
    await expectInCall(ada.page)
    await expect(main(ada.page).getByRole('alert')).toHaveCount(0)
  } finally {
    await ada.context.close()
  }
})

test('a browser that denies the microphone for real gets the same explanation', async ({
  browser,
}) => {
  const denying = await browser.browserType().launch({
    channel: process.env.PLAYWRIGHT_EXECUTABLE ? undefined : process.env.PLAYWRIGHT_CHANNEL,
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE,
    args: [
      '--disable-features=LocalNetworkAccessChecks',
      '--use-fake-device-for-media-stream',
      '--deny-permission-prompts',
    ],
  })
  const roomName = await voiceRoom('denied')
  const context = await denying.newContext()
  try {
    const page = await context.newPage()
    await member(server.admin, page, `denied${++personNumber}`, browserApp)
    await openRoom(page, roomName)
    await channelRow(page, roomName, 'denied').click()
    await join(page).click()
    await expect(main(page).getByRole('alert')).toContainText("Huddle can't use your microphone.", {
      timeout: 20000,
    })
    await expect(main(page).getByRole('button', { name: 'Try again', exact: true })).toBeVisible()
  } finally {
    await denying.close()
  }
})

test('a browser with no calling support is told before anything is requested', async ({
  browser,
}) => {
  const roomName = await voiceRoom('oldbrowser')
  const ada = await person(browser, 'ada', roomName)
  try {
    const requests: string[] = []
    ada.page.on('request', (request) => requests.push(request.url()))
    await ada.page.evaluate(() =>
      Object.defineProperty(navigator, 'mediaDevices', { value: undefined }),
    )
    await channelRow(ada.page, roomName, 'oldbrowser').click()
    await join(ada.page).click()
    await expect(main(ada.page).getByRole('alert')).toContainText("This browser can't make calls.")
    expect(requests.filter((url) => /voice|livekit/i.test(url))).toEqual([])
  } finally {
    await ada.context.close()
  }
})

test('the voice service failing is explained, and the microphone closes each time', async ({
  browser,
}) => {
  const roomName = await voiceRoom('broken')
  const ada = await person(browser, 'ada', roomName)
  try {
    await channelRow(ada.page, roomName, 'broken').click()
    const tokenRoute = '**/api/voice/token'

    await ada.page.route(tokenRoute, (route) =>
      route.fulfill({ status: 503, json: { message: 'Voice is not set up on this server.' } }),
    )
    await join(ada.page).click()
    await expect(main(ada.page).getByRole('alert')).toHaveText(
      'Voice is not set up on this server.',
    )
    await expect.poll(() => openMicrophones(ada.page)).toBe(0)
    await ada.page.unroute(tokenRoute)

    // A port nobody listens on, as an access policy that drops the signalling port would look.
    await ada.page.route(tokenRoute, async (route) => {
      const response = await route.fetch()
      await route.fulfill({
        response,
        json: { ...(await response.json()), url: 'ws://localhost:9' },
      })
    })
    await main(ada.page).getByRole('button', { name: 'Try again', exact: true }).click()
    await expect(main(ada.page).getByRole('alert')).toContainText(
      "Huddle couldn't reach the voice service at localhost:9.",
      { timeout: 40000 },
    )
    await expect(main(ada.page).getByRole('alert')).toContainText('TCP port 9')
    await expect.poll(() => openMicrophones(ada.page)).toBe(0)
    await ada.page.unroute(tokenRoute)

    await ada.page.route(tokenRoute, async (route) => {
      const response = await route.fetch()
      const grant = (await response.json()) as { token: string }
      await route.fulfill({ response, json: { ...grant, token: `${grant.token}x` } })
    })
    await main(ada.page).getByRole('button', { name: 'Try again', exact: true }).click()
    await expect(main(ada.page).getByRole('alert')).toContainText(
      'The voice service turned this call down.',
      { timeout: 40000 },
    )
    await expect.poll(() => openMicrophones(ada.page)).toBe(0)
    await ada.page.unroute(tokenRoute)

    await main(ada.page).getByRole('button', { name: 'Try again', exact: true }).click()
    await expectInCall(ada.page)
  } finally {
    await ada.context.close()
  }
})

test('a network that blocks media says audio could not get through', async ({ browser }) => {
  const roomName = await voiceRoom('nobodyhome')
  const ada = await person(browser, 'ada', roomName)
  try {
    // With no relay to use, ICE has no path, as when an access policy drops the media port.
    await ada.context.addInitScript(() => {
      const Native = window.RTCPeerConnection
      window.RTCPeerConnection = class extends Native {
        constructor(config?: RTCConfiguration) {
          super({ ...config, iceTransportPolicy: 'relay' })
        }
        override setConfiguration(config?: RTCConfiguration) {
          super.setConfiguration({ ...config, iceTransportPolicy: 'relay' })
        }
      }
    })
    await ada.page.reload()
    await openRoom(ada.page, roomName)
    await channelRow(ada.page, roomName, 'nobodyhome').click()
    await join(ada.page).click()
    await expect(main(ada.page).getByRole('alert')).toContainText('audio could not get through', {
      timeout: 60000,
    })
    await expect(main(ada.page).getByRole('alert')).toContainText('UDP port 7882')
    await expect.poll(() => openMicrophones(ada.page)).toBe(0)
  } finally {
    await ada.context.close()
  }
})

test('a microphone unplugged in a call shows muted, and unmuting without one ends the call', async ({
  browser,
}) => {
  const roomName = await voiceRoom('unplugged')
  const ada = await person(browser, 'ada', roomName)
  try {
    await channelRow(ada.page, roomName, 'unplugged').click()
    await join(ada.page).click()
    await expectInCall(ada.page)
    await ada.page.evaluate(() => {
      navigator.mediaDevices.getUserMedia = () =>
        Promise.reject(new DOMException('gone', 'NotFoundError'))
      const [microphone] = window.probe.microphones
      microphone?.stop()
      microphone?.dispatchEvent(new Event('ended'))
    })
    const mute = panel(ada.page).getByRole('button', { name: 'Mute', exact: true })
    await expect(mute).toHaveAttribute('aria-pressed', 'true')
    await mute.click()
    await expect(main(ada.page).getByRole('alert')).toHaveText('Your microphone stopped working.')
  } finally {
    await ada.context.close()
  }
})

test('joining from a second window ends the first, which says so from any page', async ({
  browser,
}) => {
  const roomName = await voiceRoom('twice')
  const ada = await person(browser, 'ada', roomName)
  const second = await ada.context.newPage()
  try {
    await channelRow(ada.page, roomName, 'twice').click()
    await join(ada.page).click()
    await expectInCall(ada.page)
    await channelRow(ada.page, roomName, 'chat').click()

    await second.goto(browserApp)
    await openRoom(second, roomName)
    await channelRow(second, roomName, 'twice').click()
    await join(second).click()
    await expectInCall(second)

    await expect(panel(ada.page).getByRole('status')).toHaveText('Call ended', { timeout: 20000 })
    await expect.poll(() => openMicrophones(ada.page)).toBe(0)
    await panel(ada.page).getByRole('button', { name: /twice/ }).click()
    await expect(main(ada.page).getByRole('alert')).toHaveText(
      'You joined this call from somewhere else, so it ended here.',
    )
    await expect(panel(ada.page)).toHaveCount(0)
    await channelRow(ada.page, roomName, 'chat').click()
    await panel(ada.page).getByRole('button', { name: 'Dismiss', exact: true }).click()
    await expect(panel(ada.page)).toHaveCount(0)
  } finally {
    await ada.context.close()
  }
})

test('losing the connection shows Reconnecting and the call comes back', async ({ browser }) => {
  const roomName = await voiceRoom('flaky')
  const ada = await person(browser, 'ada', roomName)
  try {
    await channelRow(ada.page, roomName, 'flaky').click()
    await join(ada.page).click()
    await expectInCall(ada.page)
    await ada.context.setOffline(true)
    await expect(panel(ada.page).getByRole('status')).toHaveText('Reconnecting', { timeout: 30000 })
    await expect(main(ada.page).getByText('Reconnecting.', { exact: true })).toBeVisible()
    await ada.context.setOffline(false)
    await expectInCall(ada.page)
  } finally {
    await ada.context.close()
  }
})

test('sound a browser blocks can be turned on from the panel', async ({ browser }) => {
  const roomName = await voiceRoom('blocked')
  const ada = await person(browser, 'ada', roomName)
  const bo = await person(browser, 'bo', roomName)
  try {
    await ada.page.evaluate(() => {
      let allowed = false
      window.addEventListener(
        'click',
        (event) => {
          if ((event.target as Element).closest('.call-sound')) allowed = true
        },
        true,
      )
      const play = HTMLMediaElement.prototype.play
      HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
        if (allowed) return play.call(this)
        return Promise.reject(new DOMException('blocked', 'NotAllowedError'))
      }
    })
    await channelRow(ada.page, roomName, 'blocked').click()
    await join(ada.page).click()
    await expectInCall(ada.page)
    await channelRow(bo.page, roomName, 'blocked').click()
    await join(bo.page).click()
    await expectInCall(bo.page)
    const turnOn = panel(ada.page).getByRole('button', { name: 'Turn on sound', exact: true })
    await expect(turnOn).toBeVisible({ timeout: 20000 })
    await turnOn.click()
    await expect(turnOn).toHaveCount(0)
    await expect.poll(() => playingSounds(ada.page)).toBe(1)
  } finally {
    await ada.context.close()
    await bo.context.close()
  }
})

test('losing identity ends the call and closes the microphone', async ({ browser }) => {
  const roomName = await voiceRoom('vanish')
  const ada = await person(browser, 'ada', roomName)
  try {
    await channelRow(ada.page, roomName, 'vanish').click()
    await join(ada.page).click()
    await expectInCall(ada.page)
    await ada.context.setExtraHTTPHeaders({})
    await ada.page
      .locator('.account')
      .getByRole('button', { name: 'Settings', exact: true })
      .click()
    await expect(
      ada.page.getByRole('heading', { name: 'Open Huddle through Tailscale' }),
    ).toBeVisible()
    await expect.poll(() => openMicrophones(ada.page)).toBe(0)
    await expect.poll(() => openPeers(ada.page)).toBe(0)
    await expect(panel(ada.page)).toHaveCount(0)
  } finally {
    await ada.context.close()
  }
})

test('the desktop app says calls are not there yet and asks for no microphone', async ({
  browser,
}) => {
  const roomName = await voiceRoom('native')
  const context = await browser.newContext({
    extraHTTPHeaders: tailscale(loginOf('nativecaller')),
  })
  await watchCalls(context)
  const page = await context.newPage()
  try {
    await member(server.admin, page, 'nativecaller', browserApp)
    await context.route('**/*', (route) => route.continue())
    await context.addInitScript((origin) => {
      localStorage.setItem('huddle.server', origin)
      Object.assign(window, {
        isTauri: true,
        __TAURI_INTERNALS__: { invoke: async () => null },
      })
    }, serverURL)
    await page.goto('/')
    await openRoom(page, roomName)
    await channelRow(page, roomName, 'native').click()
    await expect(
      main(page).getByText("Calls don't work in the desktop app yet.", { exact: false }),
    ).toBeVisible()
    await expect(join(page)).toHaveCount(0)
  } finally {
    await context.close()
  }
})
