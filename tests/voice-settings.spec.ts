import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { browserApp, member } from './accounts'
import { useScratchServer } from './server'
import { fakeMicrophoneLaunch, openMicrophones, watchCalls } from './voice'

const server = useScratchServer('api')
test.use({ launchOptions: fakeMicrophoneLaunch })

let personNumber = 0
const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings', exact: true })
const microphoneCard = (page: Page) =>
  settings(page).getByRole('region', { name: 'Microphone', exact: true })
const speakersCard = (page: Page) =>
  settings(page).getByRole('region', { name: 'Speakers', exact: true })
const inputDevice = (page: Page) => settings(page).getByLabel('Input device', { exact: true })
const outputDevice = (page: Page) => settings(page).getByLabel('Output device', { exact: true })
const inputVolume = (page: Page) => settings(page).getByLabel('Input volume', { exact: true })
const outputVolume = (page: Page) => settings(page).getByLabel('Output volume', { exact: true })
const meter = (page: Page) => settings(page).getByRole('meter', { name: 'Microphone level' })
const testStatus = (page: Page) => microphoneCard(page).getByRole('status')
const button = (page: Page, name: string) =>
  settings(page).getByRole('button', { name, exact: true })
const meterBars = async (page: Page) => Number(await meter(page).getAttribute('aria-valuenow'))
declare global {
  interface Window {
    loudest: number
  }
}
/** The fake microphone beeps for a few milliseconds each second, so this keeps the loudest level
 *  the meter showed rather than polling for a moment that is easy to miss. */
async function watchMeter(page: Page) {
  await meter(page).evaluate((element) => {
    window.loudest = 0
    new MutationObserver(() => {
      window.loudest = Math.max(window.loudest, Number(element.getAttribute('aria-valuenow')))
    }).observe(element, { attributes: true })
  })
}
const loudest = (page: Page) => page.evaluate(() => window.loudest)
const resetLoudest = (page: Page) => page.evaluate(() => (window.loudest = 0))

/** Chrome's fake media UI grants the microphone before anyone asks, so this restores what a real
 *  browser does: no device names until a microphone request succeeds on the page. */
async function hideLabelsUntilAllowed(context: BrowserContext) {
  await context.addInitScript(() => {
    const devices = navigator.mediaDevices
    const list = devices.enumerateDevices.bind(devices)
    const capture = devices.getUserMedia.bind(devices)
    let allowed = false
    devices.enumerateDevices = async () =>
      allowed
        ? list()
        : (await list()).map(
            (device) =>
              ({ kind: device.kind, deviceId: '', groupId: '', label: '' }) as MediaDeviceInfo,
          )
    devices.getUserMedia = async (constraints) => {
      const stream = await capture(constraints)
      allowed = true
      return stream
    }
    const query = navigator.permissions.query.bind(navigator.permissions)
    navigator.permissions.query = async (descriptor) => {
      const status = await query(descriptor)
      if (descriptor.name !== 'microphone' || allowed) return status
      return Object.assign(Object.create(status), { state: 'prompt' }) as PermissionStatus
    }
  })
}
async function newPerson(browser: Browser, prepare?: (context: BrowserContext) => Promise<void>) {
  const context = await browser.newContext()
  await watchCalls(context)
  await prepare?.(context)
  const page = await context.newPage()
  await member(server.admin, page, `voiceset${++personNumber}`, browserApp)
  return { context, page }
}
async function openVoice(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await settings(page).getByRole('button', { name: 'Voice', exact: true }).click()
  await expect(settings(page).getByRole('heading', { name: 'Voice', level: 1 })).toBeVisible()
}
async function allowMicrophone(page: Page) {
  const allow = button(page, 'Allow microphone')
  await expect(allow.or(inputDevice(page).and(page.locator(':enabled')))).toBeVisible()
  if (await allow.isVisible()) await allow.click()
  await expect(inputDevice(page)).toBeEnabled()
}
const options = (page: Page, select: typeof inputDevice) =>
  select(page)
    .locator('option')
    .evaluateAll((items) =>
      items.map((item) => ({ value: (item as HTMLOptionElement).value, label: item.textContent })),
    )

test('choices wait for the microphone, then persist across a reload', async ({ browser }) => {
  const { context, page } = await newPerson(browser, hideLabelsUntilAllowed)
  try {
    await openVoice(page)
    await expect(
      microphoneCard(page).getByText(
        'Allow the microphone to choose a device and test how you sound.',
      ),
    ).toBeVisible()
    await expect(inputDevice(page)).toBeDisabled()
    await expect(inputDevice(page)).toHaveValue('')
    await expect(inputDevice(page).locator('option')).toHaveText(['Default microphone'])
    await expect(inputVolume(page)).toBeDisabled()
    await expect(button(page, 'Test microphone')).toBeDisabled()
    await expect(outputVolume(page)).toBeEnabled()
    await expect(button(page, 'Play test sound')).toBeEnabled()
    expect(await page.evaluate(() => window.probe.microphones.length)).toBe(0)

    await button(page, 'Allow microphone').click()
    await expect(inputDevice(page)).toBeEnabled()
    await expect(button(page, 'Allow microphone')).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => window.probe.microphones.length)).toBe(1)
    await expect.poll(() => openMicrophones(page)).toBe(0)

    const inputs = await options(page, inputDevice)
    expect(inputs[0]?.value).toBe('')
    expect(inputs[0]?.label).toMatch(/^Default · .+/)
    expect(inputs.length).toBeGreaterThan(1)
    const outputs = await options(page, outputDevice)
    expect(outputs[0]?.value).toBe('')
    expect(outputs[0]?.label).toMatch(/^Default/)

    const chosen = inputs[inputs.length - 1]
    if (!chosen) throw new Error('No input device to choose')
    await inputDevice(page).selectOption(chosen.value)
    await inputVolume(page).fill('40')
    await outputVolume(page).fill('65')
    await expect(microphoneCard(page).locator('output')).toHaveText('40%')
    await expect(speakersCard(page).locator('output')).toHaveText('65%')

    await button(page, 'Play test sound').click()
    await expect(button(page, 'Playing…')).toBeDisabled()
    await expect(button(page, 'Play test sound')).toBeEnabled({ timeout: 5000 })
    expect(await page.locator('audio').count()).toBe(0)

    await page.reload()
    await openVoice(page)
    await allowMicrophone(page)
    // Chrome gives fake devices new IDs on each page, so the stored device is found by its name.
    await expect(inputDevice(page).locator('option:checked')).toHaveText(chosen.label ?? '')
    await expect(inputVolume(page)).toHaveValue('40')
    await expect(outputVolume(page)).toHaveValue('65')
    await expect(microphoneCard(page).locator('.voice-note')).toHaveCount(0)

    await inputDevice(page).selectOption('')
    await expect(inputDevice(page)).toHaveValue('')
    expect(
      await page.evaluate(() => JSON.parse(localStorage.getItem('huddle.voice.v1') ?? 'null')),
    ).toEqual({
      input: { device: null, volume: 0.4 },
      output: { device: null, volume: 0.65 },
    })
  } finally {
    await context.close()
  }
})

test('corrupt storage reads as defaults, and a device that goes away comes back on its own', async ({
  browser,
}) => {
  const { context, page } = await newPerson(browser)
  try {
    for (const stored of ['{not json', '{"input":{"device":7,"volume":"loud"},"output":null}']) {
      await page.evaluate((value) => localStorage.setItem('huddle.voice.v1', value), stored)
      await page.reload()
      await openVoice(page)
      await allowMicrophone(page)
      await expect(inputDevice(page)).toHaveValue('')
      await expect(inputVolume(page)).toHaveValue('100')
      await expect(outputVolume(page)).toHaveValue('100')
      await page.keyboard.press('Escape')
    }

    await page.evaluate(() =>
      localStorage.setItem(
        'huddle.voice.v1',
        JSON.stringify({
          input: { device: { id: 'unplugged-mic', label: 'Studio Mic' }, volume: 0.5 },
          output: { device: null, volume: 1 },
        }),
      ),
    )
    await page.reload()
    await openVoice(page)
    await allowMicrophone(page)
    await expect(inputDevice(page)).toHaveValue('')
    await expect(inputVolume(page)).toHaveValue('50')
    await expect(
      microphoneCard(page).getByText("Studio Mic disconnected. Using the default until it's back."),
    ).toBeVisible()

    const inputs = await options(page, inputDevice)
    const chosen = inputs[inputs.length - 1]
    if (!chosen?.label) throw new Error('No input device to choose')
    await inputDevice(page).selectOption(chosen.value)
    await page.evaluate((id) => {
      const devices = navigator.mediaDevices
      const list = devices.enumerateDevices.bind(devices)
      Object.assign(window, {
        unplug(gone: boolean) {
          devices.enumerateDevices = gone
            ? async () => (await list()).filter((device) => device.deviceId !== id)
            : list
          devices.dispatchEvent(new Event('devicechange'))
        },
      })
    }, chosen.value)
    const unplug = (gone: boolean) =>
      page.evaluate(
        (gone) => (window as unknown as { unplug: (gone: boolean) => void }).unplug(gone),
        gone,
      )
    await unplug(true)
    await expect(inputDevice(page)).toHaveValue('')
    await expect(
      microphoneCard(page).getByText(
        `${chosen.label} disconnected. Using the default until it's back.`,
      ),
    ).toBeVisible()
    await unplug(false)
    await expect(inputDevice(page)).toHaveValue(chosen.value)
    await expect(microphoneCard(page).locator('.voice-note')).toHaveCount(0)
  } finally {
    await context.close()
  }
})

test('without output routing the speakers say the system decides', async ({ browser }) => {
  const context = await browser.newContext()
  await context.addInitScript(() => {
    delete (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId
  })
  const page = await context.newPage()
  try {
    await member(server.admin, page, `voiceset${++personNumber}`, browserApp)
    await openVoice(page)
    await allowMicrophone(page)
    await expect(outputDevice(page)).toHaveCount(0)
    await expect(speakersCard(page).getByText('Set by your system', { exact: true })).toBeVisible()
    await expect(
      speakersCard(page).getByText("Change speakers in your computer's sound settings."),
    ).toBeVisible()
    await expect(outputVolume(page)).toBeEnabled()
  } finally {
    await context.close()
  }
})

test('the mic test meters the microphone, plays it back, and every way out closes it', async ({
  browser,
}) => {
  const { context, page } = await newPerson(browser)
  try {
    await openVoice(page)
    await allowMicrophone(page)
    await expect(testStatus(page)).toHaveText('Mic test')
    expect(await meterBars(page)).toBe(0)
    await watchMeter(page)

    await button(page, 'Test microphone').click()
    await expect(testStatus(page)).toHaveText('Listening…')
    await expect(
      microphoneCard(page).getByText('Say something. Playback starts in 4 seconds.'),
    ).toBeVisible()
    await expect.poll(() => openMicrophones(page)).toBe(1)
    await expect.poll(() => loudest(page), { timeout: 4000 }).toBeGreaterThan(8)
    await expect(
      microphoneCard(page).getByText('Say something. Playback starts in 2 seconds.'),
    ).toBeVisible()
    await expect(testStatus(page)).toHaveText('Playing back', { timeout: 6000 })
    await resetLoudest(page)
    await expect.poll(() => openMicrophones(page)).toBe(0)
    await expect(button(page, 'Stop test')).toBeVisible()
    await expect.poll(() => loudest(page), { timeout: 4000 }).toBeGreaterThan(8)
    await expect(testStatus(page)).toHaveText('Mic test', { timeout: 10000 })
    await expect(button(page, 'Test microphone')).toBeEnabled()
    expect(await meterBars(page)).toBe(0)
    expect(await page.locator('audio').count()).toBe(0)

    await button(page, 'Test microphone').click()
    await expect.poll(() => openMicrophones(page)).toBe(1)
    await button(page, 'Stop test').click()
    await expect(testStatus(page)).toHaveText('Mic test')
    await expect.poll(() => openMicrophones(page)).toBe(0)

    await button(page, 'Test microphone').click()
    await expect.poll(() => openMicrophones(page)).toBe(1)
    await settings(page).getByRole('button', { name: 'Connection', exact: true }).click()
    await expect.poll(() => openMicrophones(page)).toBe(0)

    await settings(page).getByRole('button', { name: 'Voice', exact: true }).click()
    await button(page, 'Test microphone').click()
    await expect.poll(() => openMicrophones(page)).toBe(1)
    await page.keyboard.press('Escape')
    await expect(settings(page)).toHaveCount(0)
    await expect.poll(() => openMicrophones(page)).toBe(0)

    const total = await page.evaluate(() => window.probe.microphones.length)
    await page.waitForTimeout(5000)
    expect(await page.evaluate(() => window.probe.microphones.length)).toBe(total)
  } finally {
    await context.close()
  }
})

test('a refused microphone says where to turn it back on', async ({ browser }) => {
  const denying = await browser.browserType().launch({
    channel: process.env.PLAYWRIGHT_EXECUTABLE ? undefined : process.env.PLAYWRIGHT_CHANNEL,
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE,
    args: [
      '--disable-features=LocalNetworkAccessChecks',
      '--use-fake-device-for-media-stream',
      '--deny-permission-prompts',
    ],
  })
  try {
    const page = await (await denying.newContext()).newPage()
    await member(server.admin, page, `voiceset${++personNumber}`, browserApp)
    await openVoice(page)
    await button(page, 'Allow microphone').click()
    await expect(
      microphoneCard(page).getByText(
        "Huddle can't use your microphone. Allow it in your browser's settings for this site, then try again.",
      ),
    ).toBeVisible()
    await expect(inputDevice(page)).toBeDisabled()
    await expect(button(page, 'Test microphone')).toBeDisabled()
    await expect(outputVolume(page)).toBeEnabled()
  } finally {
    await denying.close()
  }
})

test('a second window follows a change made in the first', async ({ browser }) => {
  const { context, page } = await newPerson(browser)
  const second = await context.newPage()
  try {
    await second.goto(browserApp)
    await openVoice(page)
    await openVoice(second)
    await outputVolume(page).fill('30')
    await expect(outputVolume(second)).toHaveValue('30')
    await expect(speakersCard(second).locator('output')).toHaveText('30%')
  } finally {
    await context.close()
  }
})
