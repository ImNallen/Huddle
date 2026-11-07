import { randomUUID } from 'node:crypto'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { Channel, Room, ServerInvite, parseInvite } from '../packages/contracts/src/index'
import { Client, runningLivekit } from '../apps/server/scripts/harness'
import { actAs, browserApp, onboard, railTile, serverURL } from './accounts'
import { useScratchServer } from './server'
import {
  channelRow,
  expectHearing,
  expectInCall,
  expectSilence,
  fakeMicrophoneLaunch,
  inCallList,
  join,
  openMicrophones,
  openPeers,
  panel,
  playingSounds,
  watchCalls,
} from './voice'

useScratchServer('ui')
test.beforeAll(() => runningLivekit())
test.use({ launchOptions: fakeMicrophoneLaunch })

declare global {
  interface Window {
    releaseVoiceDesignMicrophone?: () => void
  }
}

async function both(page: Page, name: string) {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await page.getByRole('main').getByRole('heading', { level: 1 }).click()
    await page.mouse.move(0, 0)
    await page.evaluate(() => document.fonts.ready)
    const path = test.info().outputPath(`${name}-${colorScheme}.png`)
    await page.screenshot({ path, animations: 'disabled' })
    await test.info().attach(`${name}-${colorScheme}`, { path, contentType: 'image/png' })
  }
}
const audibleSounds = (page: Page) =>
  page.evaluate(
    () =>
      [...document.querySelectorAll('audio')].filter(
        (audio) => audio.srcObject && !audio.paused && !audio.muted && audio.volume > 0,
      ).length,
  )

test('voice browsing matches both themes, keeps calls and drafts, and deafens real microphone and playback', async ({
  page,
  browser,
}) => {
  page.setDefaultTimeout(15000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await onboard(page, 'adam', 'Our place')
  const admin = new Client(serverURL, 'adam@huddle.test')
  await admin.stage()
  await admin.act({
    kind: 'profile.save',
    profile: { name: 'Adam Nilsson', avatar: { kind: 'mascot', shape: 'circle', color: 'teal' } },
  })
  const invite = ServerInvite.parse((await admin.call('/api/invite')).value)
  const code = parseInvite(invite.invite).code
  for (const [login, name] of [
    ['maya', 'Maya Lind'],
    ['jonas', 'Jonas Berg'],
  ] as const) {
    const friend = new Client(serverURL, `${login}@huddle.test`)
    await friend.act({ kind: 'account.join', code, name })
  }
  const room = Room.parse((await admin.call('/api/rooms', { name: 'The studio' })).value)
  const otherRoom = Room.parse((await admin.call('/api/rooms', { name: 'Book club' })).value)
  const general = Channel.parse(
    (await admin.call('/api/channels', { roomId: room.id, name: 'general', kind: 'text' })).value,
  )
  for (const name of ['the-lounge', 'quiet-corner'])
    await admin.call('/api/channels', { roomId: room.id, name, kind: 'voice' })
  await admin.call('/api/channels', { roomId: otherRoom.id, name: 'reading', kind: 'text' })
  await admin.call('/api/messages', {
    retryId: randomUUID(),
    channelId: general.id,
    body: 'A little company while you catch up.',
  })
  await watchCalls(page.context())
  await page.goto(browserApp)
  await railTile(page, 'The studio').click()
  const contexts: BrowserContext[] = []
  let releaseToken = () => {}
  async function person(login: string) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    contexts.push(context)
    await watchCalls(context)
    const friend = await context.newPage()
    await actAs(friend, login)
    await friend.goto(browserApp)
    await railTile(friend, 'The studio').click()
    return friend
  }
  try {
    const maya = await person('maya')
    await channelRow(maya, 'The studio', 'the-lounge').click()
    await join(maya).click()
    await expectInCall(maya)

    await page.evaluate(() => {
      const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        navigator.mediaDevices.getUserMedia = capture
        await new Promise<void>((resolve) => {
          window.releaseVoiceDesignMicrophone = resolve
        })
        return capture(constraints)
      }
    })
    await channelRow(page, 'The studio', 'the-lounge').click()
    await join(page).click()
    await expect.poll(() => page.evaluate(() => !!window.releaseVoiceDesignMicrophone)).toBe(true)
    await channelRow(page, 'The studio', 'general').click()
    await expect(panel(page).getByRole('status')).toHaveText('Waiting for microphone')
    await expect(panel(page)).toHaveCSS('height', '108px')
    await both(page, 'voice-permission')
    await panel(page).getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.evaluate(() => window.releaseVoiceDesignMicrophone?.())
    await expect.poll(() => openMicrophones(page)).toBe(0)

    const tokenGate = new Promise<void>((resolve) => {
      releaseToken = resolve
    })
    await page.route(
      '**/api/voice/token',
      async (route) => {
        await tokenGate
        await route.continue()
      },
      { times: 1 },
    )
    await channelRow(page, 'The studio', 'the-lounge').click()
    await join(page).click()
    await expect(panel(page).getByRole('status')).toHaveText('Joining the call…')
    await channelRow(page, 'The studio', 'general').click()
    await both(page, 'voice-joining')
    releaseToken()
    await expectInCall(page)
    await expectHearing(page)
    await expectHearing(maya)
    await expect(panel(page)).toHaveCSS('width', '244px')
    await expect(panel(page)).toHaveCSS('height', '124px')
    await expect(panel(page).locator('.call-location')).toHaveText('the-lounge · The studio')
    await expect(page.locator('.voice-in-call')).toHaveText('In call')
    await expect(page.getByRole('list', { name: 'In the-lounge', exact: true })).toContainText(
      'You',
    )
    await both(page, 'voice-text-connected')
    const microphones = await page.evaluate(() => window.probe.microphones.length)
    await railTile(page, 'Home').click()
    await both(page, 'voice-home-connected')
    await panel(page).getByRole('button', { name: 'Open the-lounge', exact: true }).click()
    await expect(
      page.getByRole('main').getByRole('heading', { name: 'the-lounge', exact: true }),
    ).toBeVisible()
    expect(await page.evaluate(() => window.probe.microphones.length)).toBe(microphones)

    const mute = panel(page).getByRole('button', { name: 'Mute', exact: true })
    const deafen = panel(page).getByRole('button', { name: 'Deafen', exact: true })
    await mute.click()
    await expect(panel(page).getByRole('status')).toHaveText('Microphone muted')
    await expectSilence(maya)
    await expectHearing(page)
    await railTile(page, 'Home').click()
    await page.getByRole('button', { name: 'New message', exact: true }).first().click()
    await page
      .getByRole('dialog', { name: 'New message', exact: true })
      .getByRole('option', { name: 'Maya Lind', exact: true })
      .click()
    const draft = page.getByRole('textbox', { name: 'Message @Maya Lind', exact: true })
    await draft.fill('Still here, just typing.')
    await both(page, 'voice-direct-muted')
    await deafen.click()
    await expect(panel(page).getByRole('status')).toHaveText('Deafened')
    await expect(mute).toBeDisabled()
    await expect(mute).toHaveAttribute('aria-pressed', 'true')
    await expect(deafen).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => audibleSounds(page)).toBe(0)
    await both(page, 'voice-deafened')

    const jonas = await person('jonas')
    await channelRow(jonas, 'The studio', 'the-lounge').click()
    await join(jonas).click()
    await expectInCall(jonas)
    await expect.poll(() => playingSounds(page)).toBe(2)
    await expect.poll(() => audibleSounds(page)).toBe(0)
    await deafen.click()
    await expect(panel(page).getByRole('status')).toHaveText('Microphone muted')
    await expect(mute).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => audibleSounds(page)).toBe(2)
    await expectHearing(page)
    await mute.click()
    await expect(panel(page).getByRole('status')).toHaveText('Voice connected')
    await expect(
      inCallList(maya).getByRole('listitem').filter({ hasText: 'Adam Nilsson' }),
    ).not.toContainText('muted')
    await deafen.click()
    await expect(panel(page).getByRole('status')).toHaveText('Deafened')

    await panel(page).getByRole('button', { name: 'Open the-lounge', exact: true }).click()
    await channelRow(page, 'The studio', 'quiet-corner').click()
    await join(page).click()
    await expect(panel(page).getByRole('status')).toHaveText('Deafened', { timeout: 40000 })
    await expect(deafen).toHaveAttribute('aria-pressed', 'true')
    await channelRow(maya, 'The studio', 'quiet-corner').click()
    await join(maya).click()
    await expectInCall(maya)
    await expect.poll(() => playingSounds(page)).toBe(1)
    await expect.poll(() => audibleSounds(page)).toBe(0)
    await railTile(page, 'Book club').click()
    await expect(panel(page).locator('.call-location')).toHaveText('quiet-corner · The studio')
    await deafen.click()
    await expect(panel(page).getByRole('status')).toHaveText('Voice connected')
    await expect(mute).toHaveAttribute('aria-pressed', 'false')
    await expectHearing(page)
    await expectHearing(maya)
    await mute.click()
    await page.context().setOffline(true)
    await expect(panel(page).getByRole('status')).toHaveText('Reconnecting · muted', {
      timeout: 30000,
    })
    await both(page, 'voice-reconnecting-muted')
    await page.context().setOffline(false)
    await expect(panel(page).getByRole('status')).toHaveText('Microphone muted', { timeout: 40000 })
    await expect(mute).toHaveAttribute('aria-pressed', 'true')
    await mute.click()
    await expectInCall(page)
    await expectHearing(maya)

    const duplicate = await person('adam')
    await channelRow(duplicate, 'The studio', 'quiet-corner').click()
    await join(duplicate).click()
    await expectInCall(duplicate)
    await expect(panel(page).getByRole('status')).toHaveText('Call ended', { timeout: 20000 })
    await expect.poll(() => openMicrophones(page)).toBe(0)
    await expect.poll(() => openPeers(page)).toBe(0)
    await expect(panel(page)).toHaveCSS('height', '108px')
    await both(page, 'voice-ended')
    await panel(page).getByRole('button', { name: 'Open quiet-corner', exact: true }).click()
    await expect(page.getByRole('main').getByRole('alert')).toContainText(
      'You joined this call from somewhere else',
    )
    await expect(panel(page)).toHaveCount(0)
    await channelRow(page, 'The studio', 'general').click()
    await panel(page).getByRole('button', { name: 'Dismiss', exact: true }).click()
    await expect(panel(page)).toHaveCount(0)
    await duplicate.context().close()

    await page.evaluate(() => {
      let allowed = false
      window.addEventListener(
        'click',
        (event) => {
          if (event.target instanceof Element && event.target.closest('.call-sound')) allowed = true
        },
        true,
      )
      const play = HTMLMediaElement.prototype.play
      HTMLMediaElement.prototype.play = function () {
        return allowed
          ? play.call(this)
          : Promise.reject(new DOMException('blocked', 'NotAllowedError'))
      }
    })
    await channelRow(page, 'The studio', 'quiet-corner').click()
    await join(page).click()
    await expectInCall(page)
    await channelRow(page, 'The studio', 'general').click()
    const sound = panel(page).getByRole('button', { name: 'Turn on sound', exact: true })
    await expect(sound).toBeVisible({ timeout: 20000 })
    await expect(panel(page)).toHaveCSS('height', '170px')
    await both(page, 'voice-sound-blocked')
    await sound.click()
    await expect(sound).toHaveCount(0)
    await expect.poll(() => audibleSounds(page)).toBe(1)
    await railTile(page, 'Home').click()
    await page
      .getByRole('navigation', { name: 'Our place', exact: true })
      .getByRole('button', { name: /Maya Lind/ })
      .click()
    await expect(draft).toHaveValue('Still here, just typing.')
    await panel(page).getByRole('button', { name: 'Leave call', exact: true }).click()
    await expect(panel(page)).toHaveCount(0)
    await expect.poll(() => openMicrophones(page)).toBe(0)
    await expect.poll(() => openPeers(page)).toBe(0)
    await expect.poll(() => playingSounds(page)).toBe(0)
  } finally {
    releaseToken()
    await page.context().setOffline(false)
    await page.evaluate(() => window.releaseVoiceDesignMicrophone?.()).catch(() => {})
    await Promise.all(contexts.map((context) => context.close()))
  }
})
