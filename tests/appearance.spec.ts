import { expect, test, type Locator, type Page } from '@playwright/test'
import { browserApp, expectHome, member, serverURL } from './accounts'
import { useScratchServer } from './server'
import { contrast, parseColor, rgbaOf } from '../packages/ui/src/appearance/color'
import { TOKEN_NAMES } from '../packages/ui/src/appearance/palette'

const server = useScratchServer('api')

const DARK_GROUND = 'rgb(22, 22, 22)'
const LIGHT_GROUND = 'rgb(252, 252, 252)'
const APPEARANCE_KEYS = {
  mode: 'huddle.appearance.mode',
  selected: 'huddle.appearance.selected.v1',
  themes: 'huddle.themes.v1',
  paint: 'huddle.appearance.paint.v1',
}

const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings', exact: true })
const panelOf = (page: Page) => page.getByRole('dialog', { name: 'Create theme', exact: true })
const addDialog = (page: Page) => page.getByRole('dialog', { name: 'Add a theme', exact: true })
const swatch = (page: Page, name: string) => page.getByRole('radio', { name, exact: true })
const schemeRadio = (page: Page, label: string) =>
  page
    .getByRole('radiogroup', { name: 'Color scheme' })
    .getByRole('radio', { name: label, exact: true })
const createButton = (page: Page) =>
  settings(page).getByRole('button', { name: 'Create theme', exact: true })

async function signIn(page: Page, person: string) {
  await member(server.admin, page, person, browserApp)
  await expectHome(page)
}
async function openAppearance(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await settings(page).getByRole('button', { name: 'Appearance', exact: true }).click()
  await expect(settings(page).getByRole('heading', { name: 'Appearance' })).toBeVisible()
}
const rootStyle = (page: Page) =>
  page.evaluate(() => {
    const style = getComputedStyle(document.documentElement)
    return {
      background: style.backgroundColor,
      colorScheme: style.colorScheme,
      scheme: document.documentElement.dataset.scheme ?? null,
    }
  })
const tokens = (page: Page) =>
  page.evaluate((names) => {
    const probe = document.createElement('span')
    probe.hidden = true
    document.body.append(probe)
    const out: Record<string, string> = {}
    for (const name of names) {
      probe.style.color = `var(--${name})`
      out[name] = getComputedStyle(probe).color
    }
    probe.remove()
    return out
  }, TOKEN_NAMES)
const ratio = (one: string | undefined, two: string | undefined) => {
  const first = parseColor(one ?? '')
  const second = parseColor(two ?? '')
  if (!first || !second) throw new Error(`Not colors: ${one}, ${two}`)
  return contrast(rgbaOf(first), rgbaOf(second))
}
const storedKeys = (page: Page) =>
  page.evaluate(
    (keys) => keys.filter((key) => localStorage.getItem(key) !== null),
    Object.values(APPEARANCE_KEYS),
  )
const backdropOf = (dialog: Locator) =>
  dialog.evaluate((element) => getComputedStyle(element, '::backdrop').backgroundColor)

test.describe('first paint', () => {
  const recordAtBody = (page: Page, stored: Record<string, string>) =>
    page.addInitScript((values) => {
      try {
        for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value)
      } catch {
        return
      }
      new MutationObserver((_, observer) => {
        if (!document.body) return
        observer.disconnect()
        const flag = document.createElement('meta')
        flag.dataset.scheme = document.documentElement.dataset.scheme ?? 'none'
        flag.dataset.sheets = String(document.adoptedStyleSheets.length)
        flag.dataset.background = getComputedStyle(document.documentElement).backgroundColor
        flag.id = 'first-paint'
        document.head.append(flag)
      }).observe(document, { childList: true, subtree: true })
    }, stored)
  const firstPaint = (page: Page) =>
    page.locator('#first-paint').evaluate((flag: HTMLElement) => ({ ...flag.dataset }))

  for (const entry of ['server', 'desktop'] as const) {
    test(`light beats a dark OS when the body appears in the ${entry} entry`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: 'dark' })
      const problems: string[] = []
      page.on('pageerror', (error) => problems.push(error.message))
      page.on('console', (message) => {
        if (message.type() === 'error' && /hydrat|#418|#423/i.test(message.text())) {
          problems.push(message.text())
        }
      })
      await recordAtBody(page, { [APPEARANCE_KEYS.mode]: 'light' })
      await page.goto(entry === 'server' ? browserApp : '/')
      await expect.poll(() => firstPaint(page)).toMatchObject({ scheme: 'light', sheets: '0' })
      if (entry === 'server') expect((await firstPaint(page)).background).toBe(LIGHT_GROUND)
      await expect
        .poll(() => rootStyle(page))
        .toMatchObject({
          background: LIGHT_GROUND,
          colorScheme: 'light',
        })
      expect(problems).toEqual([])
    })

    test(`a stored custom half is painted when the body appears in the ${entry} entry`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: 'dark' })
      const id = '6d1f0c58-6a33-4f0e-9d3c-0d6f8a1b2c3d'
      await recordAtBody(page, {
        [APPEARANCE_KEYS.mode]: 'dark',
        [APPEARANCE_KEYS.themes]: JSON.stringify([
          {
            id,
            name: 'Stored',
            dark: { background: '#102030', accent: '#346bf1', overrides: {} },
          },
        ]),
        [APPEARANCE_KEYS.selected]: JSON.stringify({ light: 'huddle', dark: id }),
        [APPEARANCE_KEYS.paint]: JSON.stringify({ dark: { bg: '#102030' } }),
      })
      await page.goto(entry === 'server' ? browserApp : '/')
      await expect.poll(() => firstPaint(page)).toMatchObject({ scheme: 'dark', sheets: '1' })
      if (entry === 'server') expect((await firstPaint(page)).background).toBe('rgb(16, 32, 48)')
      await expect.poll(() => rootStyle(page)).toMatchObject({ background: 'rgb(16, 32, 48)' })
      await expect
        .poll(() =>
          page.evaluate(
            (key) => Object.keys(JSON.parse(localStorage.getItem(key) ?? '{}').dark ?? {}).length,
            APPEARANCE_KEYS.paint,
          ),
        )
        .toBe(TOKEN_NAMES.length)
    })
  }

  test('the server entry paints a stored mode with its client JavaScript blocked', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.addInitScript((key) => localStorage.setItem(key, 'light'), APPEARANCE_KEYS.mode)
    await page.route('**/assets/*.js', (route) => route.abort())
    await page.goto(browserApp)
    await expect
      .poll(() => rootStyle(page))
      .toMatchObject({
        background: LIGHT_GROUND,
        colorScheme: 'light',
        scheme: 'light',
      })
  })

  test('a hostile paint cache is refused whole and makes no request', async ({ page }) => {
    const external: string[] = []
    page.on('request', (request) => {
      if (!request.url().startsWith(serverURL) && !request.url().startsWith('data:')) {
        external.push(request.url())
      }
    })
    await page.emulateMedia({ colorScheme: 'dark' })
    await recordAtBody(page, {
      [APPEARANCE_KEYS.paint]: JSON.stringify({
        dark: { bg: 'url(https://evil.test/x)', panel: '#000000' },
      }),
    })
    await page.goto(browserApp)
    await expect.poll(() => firstPaint(page)).toMatchObject({ sheets: '0' })
    expect((await firstPaint(page)).background).toBe(DARK_GROUND)
    expect(external).toEqual([])
  })
})

test('a first visit writes nothing and follows the OS live, and a chosen mode survives reload', async ({
  page,
}) => {
  await signIn(page, 'firstvisit')
  await page.emulateMedia({ colorScheme: 'light' })
  expect((await rootStyle(page)).background).toBe(LIGHT_GROUND)
  await page.emulateMedia({ colorScheme: 'dark' })
  expect((await rootStyle(page)).background).toBe(DARK_GROUND)
  await openAppearance(page)
  await expect(schemeRadio(page, 'System')).toBeChecked()
  expect(await storedKeys(page)).toEqual([])

  await schemeRadio(page, 'Light').check()
  expect(await rootStyle(page)).toEqual({
    background: LIGHT_GROUND,
    colorScheme: 'light',
    scheme: 'light',
  })
  expect(await backdropOf(settings(page))).toBe('rgba(255, 255, 255, 0.55)')
  await page.emulateMedia({ colorScheme: 'light' })
  await page.emulateMedia({ colorScheme: 'dark' })
  expect((await rootStyle(page)).background).toBe(LIGHT_GROUND)
  await page.reload()
  await expectHome(page)
  expect(await rootStyle(page)).toEqual({
    background: LIGHT_GROUND,
    colorScheme: 'light',
    scheme: 'light',
  })

  await page.emulateMedia({ colorScheme: 'light' })
  await openAppearance(page)
  await schemeRadio(page, 'Dark').check()
  expect(await backdropOf(settings(page))).toBe('rgba(0, 0, 0, 0.7)')
  await page.reload()
  await expectHome(page)
  expect(await rootStyle(page)).toEqual({
    background: DARK_GROUND,
    colorScheme: 'dark',
    scheme: 'dark',
  })

  await openAppearance(page)
  await schemeRadio(page, 'System').check()
  expect(await rootStyle(page)).toMatchObject({ background: LIGHT_GROUND, scheme: null })
  expect(await storedKeys(page)).not.toContain(APPEARANCE_KEYS.mode)
})

test('Appearance works while the account request is failing', async ({ page }) => {
  await signIn(page, 'noaccount')
  await page.route('**/api/account', (route) => route.abort())
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(settings(page)).toContainText('Loading your account…')
  await settings(page).getByRole('button', { name: 'Appearance', exact: true }).click()
  await expect(settings(page)).not.toContainText('Loading your account…')
  await schemeRadio(page, 'Dark').check()
  expect((await rootStyle(page)).background).toBe(DARK_GROUND)
  await swatch(page, 'Clay dark').check()
  expect((await rootStyle(page)).background).toBe('rgb(20, 16, 13)')
})

test('swatches show their own side whatever the app is showing', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await signIn(page, 'swatches')
  await openAppearance(page)
  const ground = (name: string) =>
    swatch(page, name).evaluate((radio) => {
      const probe = document.createElement('span')
      probe.style.color = 'var(--bg)'
      radio.parentElement?.append(probe)
      const value = getComputedStyle(probe).color
      probe.remove()
      return value
    })
  expect(await ground('Huddle light')).toBe(LIGHT_GROUND)
  expect(await ground('Huddle dark')).toBe(DARK_GROUND)
  await swatch(page, 'Clay dark').check()
  expect((await rootStyle(page)).background).toBe('rgb(20, 16, 13)')
  expect(await ground('Huddle light')).toBe(LIGHT_GROUND)
  expect(await ground('Huddle dark')).toBe(DARK_GROUND)
  expect(await ground('Clay light')).toBe('rgb(250, 246, 242)')
})

test('the keyboard picks each side, and an off-screen pick waits for its mode', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await signIn(page, 'keyboard')
  await openAppearance(page)
  await settings(page).getByRole('button', { name: 'Add theme', exact: true }).focus()
  await page.keyboard.press('Tab')
  await expect(swatch(page, 'Huddle light')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(swatch(page, 'Huddle dark')).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(swatch(page, 'Indigo dark')).toBeFocused()
  await expect(swatch(page, 'Indigo dark')).toBeChecked()
  expect((await rootStyle(page)).background).toBe('rgb(27, 26, 31)')

  await swatch(page, 'Clay light').check()
  expect((await rootStyle(page)).background).toBe('rgb(27, 26, 31)')
  await expect(page.getByRole('status').filter({ hasText: 'Clay' })).toHaveText(
    'Clay shows when your system is light.',
  )
  await schemeRadio(page, 'Dark').check()
  await expect(page.getByRole('status').filter({ hasText: 'Clay' })).toHaveText(
    'Clay shows when the color scheme is Light.',
  )
  await schemeRadio(page, 'Light').check()
  expect((await rootStyle(page)).background).toBe('rgb(250, 246, 242)')
  await expect(page.getByRole('status').filter({ hasText: 'Clay' })).toHaveCount(0)
  await page.reload()
  await expectHome(page)
  expect((await rootStyle(page)).background).toBe('rgb(250, 246, 242)')
})

test('a draft previews on the real app, and every way out restores the prior state', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await signIn(page, 'preview')
  const before = await tokens(page)
  const attribute = (await rootStyle(page)).scheme
  await openAppearance(page)
  const panel = panelOf(page)
  const edit = async () => {
    await createButton(page).click()
    await panel.getByRole('radio', { name: 'Light', exact: true }).check()
    await panel.getByRole('textbox', { name: 'Background', exact: true }).fill('#fdf6e3')
    await panel.getByRole('textbox', { name: 'Accent', exact: true }).fill('#b4541f')
    await expect
      .poll(() => rootStyle(page))
      .toMatchObject({
        background: 'rgb(253, 246, 227)',
        scheme: 'light',
      })
  }
  const expectRestored = async () => {
    await expect.poll(() => tokens(page)).toEqual(before)
    expect((await rootStyle(page)).scheme).toBe(attribute)
  }
  await edit()
  await panel.getByRole('textbox', { name: 'Accent', exact: true }).fill('#not')
  await expect(panel.getByRole('alert')).toHaveText('Accent is not a color.')
  expect((await rootStyle(page)).background).toBe('rgb(253, 246, 227)')
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expectRestored()

  await edit()
  await page.keyboard.press('Escape')
  await expectRestored()

  await edit()
  await page.reload()
  await expectHome(page)
  await expectRestored()
  expect(await storedKeys(page)).toEqual([])
})

test('the panel sits above Settings, keeps a stray click, and returns focus', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await signIn(page, 'toplayer')
  await openAppearance(page)
  const panel = panelOf(page)
  const opener = createButton(page)
  await opener.click()
  await expect(panel).toBeVisible()
  const name = panel.getByRole('textbox', { name: 'Theme name' })
  await expect(name).toBeFocused()
  await expect(settings(page)).toHaveCount(1)
  expect(await backdropOf(settings(page))).toBe('rgba(0, 0, 0, 0)')

  await page.mouse.click(5, 5)
  await expect(panel).toBeVisible()
  const box = await name.boundingBox()
  if (!box) throw new Error('The name field has no box.')
  await page.mouse.move(box.x + 10, box.y + 10)
  await page.mouse.down()
  await page.mouse.move(5, 5, { steps: 4 })
  await page.mouse.up()
  await expect(panel).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(settings(page)).toBeVisible()
  await expect(opener).toBeFocused()
  expect(await backdropOf(settings(page))).toBe('rgba(0, 0, 0, 0.7)')
  await page.keyboard.press('Escape')
  await expect(settings(page)).toHaveCount(0)
})

test('a saved theme survives reload, bad seeds stay readable, and Advanced is verbatim', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await signIn(page, 'saving')
  await openAppearance(page)
  const panel = panelOf(page)

  await createButton(page).click()
  await panel.getByRole('button', { name: 'Create theme', exact: true }).click()
  await expect(panel.getByRole('alert')).toHaveText('Give this theme a name.')
  await panel.getByRole('textbox', { name: 'Theme name' }).fill('Gravel')
  await panel.getByRole('textbox', { name: 'Background', exact: true }).fill('#808080')
  await panel.getByRole('textbox', { name: 'Accent', exact: true }).fill('#ffff00')
  await expect(panel).toContainText('so text stays readable.')
  const during = await tokens(page)
  for (const name of ['text', 'muted', 'faint'] as const) {
    expect(ratio(during[name], during.bg)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(during[name], during.panel)).toBeGreaterThanOrEqual(4.5)
  }
  expect(ratio(during['on-accent'], during.accent)).toBeGreaterThanOrEqual(4.5)

  await panel.getByRole('switch', { name: 'Advanced' }).check()
  const muted = panel.getByRole('textbox', { name: 'Muted text', exact: true })
  await expect(muted).toHaveAttribute('placeholder', /^#/)
  await muted.fill('#222222')
  await expect(panel.getByText(/^1\.\d:1 on /)).toBeVisible()
  expect((await tokens(page)).muted).toBe('rgb(34, 34, 34)')
  await panel.getByRole('switch', { name: 'Advanced' }).uncheck()
  await expect(panel).toContainText('1 color set individually.')
  await panel.getByRole('switch', { name: 'Advanced' }).check()
  await expect(muted).toHaveValue('#222222')

  await panel.getByRole('button', { name: 'Create theme', exact: true }).click()
  await expect(panel).toHaveCount(0)
  await expect(swatch(page, 'Gravel dark')).toBeChecked()
  const saved = await tokens(page)
  expect(saved.muted).toBe('rgb(34, 34, 34)')
  await page.reload()
  await expectHome(page)
  expect(await tokens(page)).toEqual(saved)
})

test('saving a half the current mode would hide switches to it, and Create builds two sides', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await signIn(page, 'merging')
  await openAppearance(page)
  const panel = panelOf(page)
  const create = async (scheme: 'Light' | 'Dark', background: string) => {
    await createButton(page).click()
    await panel.getByRole('textbox', { name: 'Theme name' }).fill('Aurora')
    await panel.getByRole('radio', { name: scheme, exact: true }).check()
    await panel.getByRole('textbox', { name: 'Background', exact: true }).fill(background)
    await panel.getByRole('button', { name: 'Create theme', exact: true }).click()
  }
  await create('Light', '#fdf6e3')
  await expect(panel).toHaveCount(0)
  await expect(schemeRadio(page, 'Light')).toBeChecked()
  expect((await rootStyle(page)).background).toBe('rgb(253, 246, 227)')
  await expect(swatch(page, 'Aurora light')).toBeChecked()
  await expect(swatch(page, 'Aurora dark')).toHaveCount(0)
  await expect(page.getByRole('status').filter({ hasText: 'Aurora' })).toHaveCount(0)

  await create('Dark', '#14171f')
  await expect(panel).toHaveCount(0)
  await expect(swatch(page, 'Aurora dark')).toBeChecked()
  await expect(page.getByRole('radio', { name: /^Aurora / })).toHaveCount(2)
  await expect(schemeRadio(page, 'Dark')).toBeChecked()

  await create('Dark', '#222222')
  await expect(panel.getByRole('alert')).toHaveText(
    'Aurora already has a different dark version. Choose another name.',
  )
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('radio', { name: /^Aurora / })).toHaveCount(2)
})

test('themes import by paste, by file with comments, and by drop', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await signIn(page, 'importer')
  await openAppearance(page)
  const dialog = addDialog(page)
  const add = () => settings(page).getByRole('button', { name: 'Add theme', exact: true }).click()
  const confirm = () => dialog.getByRole('button', { name: 'Add theme', exact: true }).click()

  await add()
  await dialog.getByRole('textbox', { name: 'Theme JSON' }).fill(
    JSON.stringify({
      version: 1,
      name: 'Pasted',
      appearance: 'dark',
      colors: { canvas: 'oklch(0.2 0.02 250)', accent: '#ff7a59', text: '#111111' },
      variants: { light: { canvas: '#faf7f2', accent: '#9c3d1e' } },
    }),
  )
  await expect(dialog).toContainText('Adds Pasted, light and dark. Adjusted 1 color for readable')
  await confirm()
  await expect(dialog).toHaveCount(0)
  await expect(swatch(page, 'Pasted dark')).toBeChecked()
  await expect(swatch(page, 'Pasted light')).toBeChecked()
  const pasted = await tokens(page)
  expect(ratio(pasted.text, pasted.bg)).toBeGreaterThanOrEqual(4.5)

  await add()
  await dialog.getByLabel('Theme file').setInputFiles({
    name: 'night-owl.json',
    mimeType: 'application/json',
    buffer: Buffer.from(`// Night Owl
      {
        "type": "dark",
        "colors": {
          "editor.background": "#011627", /* ground */
          "button.background": "#7e57c2",
          "peekView.border": "not read",
        },
        "tokenColors": [],
      }`),
  })
  await expect(dialog).toContainText('Adds night-owl, dark.')
  await confirm()
  await expect(dialog).toHaveCount(0)
  await expect(swatch(page, 'night-owl dark')).toBeChecked()
  expect((await rootStyle(page)).background).toBe('rgb(1, 22, 39)')

  await add()
  const dataTransfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer()
    const file = new File(
      [
        JSON.stringify({
          version: 1,
          name: 'Dropped',
          appearance: 'dark',
          colors: { canvas: '#1a1320', accent: '#d36bff' },
        }),
      ],
      'dropped.json',
      { type: 'application/json' },
    )
    transfer.items.add(file)
    return transfer
  })
  await dialog.getByRole('heading', { name: 'Add a theme' }).dispatchEvent('drop', { dataTransfer })
  await expect(dialog).toContainText('Adds Dropped, dark.')
  await confirm()
  await expect(swatch(page, 'Dropped dark')).toBeChecked()

  await add()
  await dialog.getByRole('textbox', { name: 'Theme JSON' }).fill(
    JSON.stringify({
      version: 1,
      name: 'dropped',
      appearance: 'dark',
      colors: { canvas: '#222222' },
    }),
  )
  await confirm()
  await expect(dialog.getByRole('alert')).toContainText('Dropped already has a different dark')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(settings(page)).toBeVisible()
  await expect(settings(page).getByRole('button', { name: 'Add theme', exact: true })).toBeFocused()
})

test('a hostile theme file is refused, names the role, and requests nothing', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await signIn(page, 'hostile')
  const external: string[] = []
  page.on('request', (request) => {
    if (!request.url().startsWith(serverURL) && !request.url().startsWith('data:')) {
      external.push(request.url())
    }
  })
  await openAppearance(page)
  await settings(page).getByRole('button', { name: 'Add theme', exact: true }).click()
  const dialog = addDialog(page)
  const json = dialog.getByRole('textbox', { name: 'Theme JSON' })
  const confirm = dialog.getByRole('button', { name: 'Add theme', exact: true })
  for (const [role, value] of [
    ['canvas', 'url(https://evil.test/x)'],
    ['accent', '#fff;}'],
    ['terminalRed', 'var(--x)'],
  ] as const) {
    await json.fill(JSON.stringify({ version: 1, name: 'Bad', colors: { [role]: value } }))
    await expect(dialog.getByRole('alert')).toContainText(`${role} is not a color`)
    await expect(confirm).toBeDisabled()
  }
  await page.keyboard.press('Escape')
  await expect(swatch(page, 'Bad dark')).toHaveCount(0)
  expect(external).toEqual([])
  expect(await storedKeys(page)).toEqual([])
})

test("copying Huddle reads CSS under another theme, and pasting it back is Huddle's own", async ({
  context,
  page,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: serverURL })
  await page.emulateMedia({ colorScheme: 'dark' })
  await signIn(page, 'copier')
  const huddle = await tokens(page)
  await openAppearance(page)
  await swatch(page, 'Clay dark').check()
  expect((await rootStyle(page)).background).toBe('rgb(20, 16, 13)')
  await page.getByRole('button', { name: 'Copy Huddle as JSON', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Copy Huddle as JSON', exact: true }),
  ).toHaveAttribute('data-tooltip', 'Copied')
  const text = await page.evaluate(() => navigator.clipboard.readText())
  const file = JSON.parse(text) as { name: string; colors: Record<string, string> }
  expect(file.name).toBe('Huddle')
  expect(file.colors.canvas).toBe('#161616')
  expect(file.colors.accent).toBe('#eaeaea')

  await settings(page).getByRole('button', { name: 'Add theme', exact: true }).click()
  const dialog = addDialog(page)
  await dialog.getByRole('textbox', { name: 'Theme JSON' }).fill(text)
  await dialog.getByRole('button', { name: 'Add theme', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(swatch(page, 'Huddle dark')).toBeChecked()
  await expect(page.getByRole('radio', { name: /^Huddle / })).toHaveCount(2)
  await expect.poll(() => tokens(page)).toEqual(huddle)

  await page.getByRole('button', { name: 'Copy Clay as JSON', exact: true }).click()
  const clay = await page.evaluate(() => navigator.clipboard.readText())
  await settings(page).getByRole('button', { name: 'Add theme', exact: true }).click()
  await dialog.getByRole('textbox', { name: 'Theme JSON' }).fill(clay)
  await dialog.getByRole('button', { name: 'Add theme', exact: true }).click()
  await expect(swatch(page, 'Clay dark')).toBeChecked()
  await expect(page.getByRole('radio', { name: /^Clay / })).toHaveCount(2)
})

test('Huddle takes over from a deleted, corrupt, or unreadable theme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await signIn(page, 'fallback')
  await openAppearance(page)
  await settings(page).getByRole('button', { name: 'Add theme', exact: true }).click()
  await addDialog(page)
    .getByRole('textbox', { name: 'Theme JSON' })
    .fill(
      JSON.stringify({
        version: 1,
        name: 'Doomed',
        appearance: 'dark',
        colors: { canvas: '#102030' },
      }),
    )
  await addDialog(page).getByRole('button', { name: 'Add theme', exact: true }).click()
  expect((await rootStyle(page)).background).toBe('rgb(16, 32, 48)')

  await expect(page.getByRole('button', { name: 'Delete Clay', exact: true })).toHaveCount(0)
  const remove = page.getByRole('button', { name: 'Delete Doomed', exact: true })
  await page.getByRole('button', { name: 'More actions for Doomed', exact: true }).click()
  await remove.click()
  const confirm = page.getByRole('dialog', { name: 'Delete Doomed?', exact: true })
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(swatch(page, 'Doomed dark')).toBeChecked()
  await page.getByRole('button', { name: 'More actions for Doomed', exact: true }).click()
  await remove.click()
  await confirm.getByRole('button', { name: 'Delete theme', exact: true }).click()
  await expect(swatch(page, 'Doomed dark')).toHaveCount(0)
  await expect(swatch(page, 'Huddle dark')).toBeChecked()
  expect((await rootStyle(page)).background).toBe(DARK_GROUND)
  await page.reload()
  await expectHome(page)
  expect((await rootStyle(page)).background).toBe(DARK_GROUND)

  await page.evaluate(
    ({ themes, selected }) => {
      localStorage.setItem(themes, '{corrupt')
      localStorage.setItem(selected, JSON.stringify({ light: 'gone', dark: 'gone' }))
    },
    { themes: APPEARANCE_KEYS.themes, selected: APPEARANCE_KEYS.selected },
  )
  await page.reload()
  await expectHome(page)
  expect((await rootStyle(page)).background).toBe(DARK_GROUND)
  await openAppearance(page)
  await expect(swatch(page, 'Huddle dark')).toBeChecked()

  await page.addInitScript(() => {
    const read = Storage.prototype.getItem
    Storage.prototype.getItem = function (key: string) {
      if (key.startsWith('huddle.appearance') || key.startsWith('huddle.themes')) {
        throw new Error('blocked')
      }
      return read.call(this, key)
    }
  })
  await page.reload()
  await expectHome(page)
  expect((await rootStyle(page)).background).toBe(DARK_GROUND)
  await openAppearance(page)
  await schemeRadio(page, 'Light').check()
  expect((await rootStyle(page)).background).toBe(LIGHT_GROUND)
})

test('a second window follows a change through storage', async ({ context, page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await signIn(page, 'windows')
  const second = await context.newPage()
  await second.emulateMedia({ colorScheme: 'dark' })
  await second.goto(browserApp)
  await expectHome(second)
  await openAppearance(page)
  await schemeRadio(page, 'Light').check()
  await expect.poll(() => rootStyle(second)).toMatchObject({ background: LIGHT_GROUND })
  await swatch(page, 'Clay light').check()
  await expect.poll(() => rootStyle(second)).toMatchObject({ background: 'rgb(250, 246, 242)' })
})

const VSX = 'https://open-vsx.org'
type VsxFile = string | { status: number } | { hold: Promise<string> }

/** Stands in for the registry, so these runs reach nothing. Every request it sees is recorded. */
async function stubOpenVsx(
  page: Page,
  searches: (query: string) => VsxFile,
  files: Record<string, VsxFile>,
) {
  const requests: string[] = []
  await page.route(`${VSX}/**`, async (route) => {
    const url = new URL(route.request().url())
    requests.push(url.pathname + url.search)
    const path = decodeURIComponent(url.pathname)
    const file =
      path === '/api/-/search'
        ? searches(url.searchParams.get('query') ?? '')
        : (files[path] ?? { status: 404 })
    const headers = { 'access-control-allow-origin': '*' }
    if (typeof file === 'object' && 'status' in file) {
      return route.fulfill({ status: file.status, headers })
    }
    const body = typeof file === 'string' ? file : await file.hold
    await route.fulfill({ status: 200, headers, contentType: 'application/json', body })
  })
  return requests
}
const entry = (name: string, title: string, extra: object = {}) => ({
  namespace: 'acme',
  name,
  version: '1.0.0',
  displayName: title,
  description: `${title} description`,
  downloadCount: 1234,
  ...extra,
})
const fileOf = (name: string, path: string) => `/vscode/unpkg/acme/${name}/1.0.0/extension/${path}`
const manifestOf = (name: string, themes: object[]) => ({
  [fileOf(name, 'package.json')]: JSON.stringify({ contributes: { themes } }),
})
const results = (...extensions: object[]) => JSON.stringify({ extensions })
async function openAdd(page: Page) {
  await settings(page).getByRole('button', { name: 'Add theme', exact: true }).click()
  await expect(addDialog(page)).toBeVisible()
  return addDialog(page).getByRole('searchbox', { name: 'Search community themes' })
}

test('Open VSX is reached only after a search, and an install pairs, includes, and refuses', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await signIn(page, 'installing')
  const requests = await stubOpenVsx(
    page,
    () =>
      results(
        entry('aurora', 'Aurora Pack', { files: { icon: 'https://evil.test/icon.png' } }),
        entry('icons', 'Only Icons'),
        entry('old', 'Old Pack', { deprecated: true }),
        { ...entry('bad', 'Bad Identifier'), namespace: '../..' },
        entry('gone', 'Gone Manifest'),
      ),
    {
      ...manifestOf('aurora', [
        { label: 'Aurora Dark', uiTheme: 'vs-dark', path: './themes/dark.jsonc' },
        { label: 'Aurora Light', uiTheme: 'vs', path: './themes/light.json' },
        { label: 'Aurora Hostile', uiTheme: 'vs-dark', path: './themes/hostile.json' },
        { label: 'Aurora Outside', uiTheme: 'vs-dark', path: '../../secret.json' },
        { label: 'Aurora Loop', uiTheme: 'vs-dark', path: './themes/loop.json' },
      ]),
      ...manifestOf('icons', []),
      [fileOf('aurora', 'themes/dark.jsonc')]: `{
        // A comment, because real theme files have them.
        "include": "../base.json",
        "colors": { "editor.background": "#101820", "sideBar.background": null, },
      }`,
      [fileOf('aurora', 'base.json')]: JSON.stringify({
        colors: { 'button.background': '#ff0066', 'editor.background': '#000000' },
      }),
      [fileOf('aurora', 'themes/light.json')]: JSON.stringify({
        colors: { 'editor.background': '#fdf6e3', 'button.background': '#1b4ed8' },
      }),
      [fileOf('aurora', 'themes/hostile.json')]: JSON.stringify({
        colors: { 'editor.background': 'url(https://evil.test/x)' },
      }),
      [fileOf('aurora', 'themes/loop.json')]: JSON.stringify({
        include: './loop.json',
        colors: { 'editor.background': '#222222' },
      }),
    },
  )
  const external: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('evil.test')) external.push(request.url())
  })
  await openAppearance(page)
  const before = await storedKeys(page)
  const search = await openAdd(page)
  const dialog = addDialog(page)
  expect(requests).toEqual([])

  await search.fill('aurora')
  const install = dialog.getByRole('button', { name: 'Install Aurora Pack' })
  await expect(install).toBeVisible()
  await expect(dialog.getByRole('status')).toHaveText('1 extension')
  for (const hidden of ['Only Icons', 'Old Pack', 'Bad Identifier', 'Gone Manifest']) {
    await expect(dialog.getByText(hidden)).toHaveCount(0)
  }
  await expect(dialog.locator('.vsx-card img')).toHaveCount(0)
  await expect(dialog.getByText('acme · 1.2K downloads')).toBeVisible()
  await expect(dialog.getByText('4 themes')).toBeVisible()
  expect(requests[0]).toContain('category=Themes')
  expect(requests[0]).toContain('sortBy=relevance')

  await install.click()
  await expect(dialog).toHaveCount(0)
  await expect(settings(page).getByRole('status')).toContainText(
    'Added 1 theme from Aurora Pack. 2 themes could not be read.',
  )
  await expect(swatch(page, 'Aurora dark')).toBeChecked()
  await expect(swatch(page, 'Aurora light')).toBeChecked()
  await expect(schemeRadio(page, 'System')).toBeChecked()
  const shown = await tokens(page)
  expect(shown.bg).toBe('rgb(16, 24, 32)')
  expect(shown.accent).toBe('rgb(255, 0, 102)')
  expect(external).toEqual([])
  expect(requests.filter((path) => path.includes('secret'))).toEqual([])

  await page.reload()
  await expectHome(page)
  expect(await tokens(page)).toEqual(shown)
  await openAppearance(page)
  await expect(swatch(page, 'Aurora dark')).toBeChecked()
  expect(before).toEqual([])
})

test('Undo takes back a whole install, including the selection and a moved mode', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await signIn(page, 'undoing')
  await stubOpenVsx(page, () => results(entry('pack', 'Light Pack')), {
    ...manifestOf('pack', [
      { label: 'One', uiTheme: 'vs', path: './one.json' },
      { label: 'Two', uiTheme: 'vs', path: './two.json' },
    ]),
    [fileOf('pack', 'one.json')]: JSON.stringify({ colors: { 'editor.background': '#fdf6e3' } }),
    [fileOf('pack', 'two.json')]: JSON.stringify({ colors: { 'editor.background': '#eeeeee' } }),
  })
  await openAppearance(page)
  await swatch(page, 'Moss dark').check()
  const prior = await tokens(page)
  const search = await openAdd(page)
  await search.fill('pack')
  await addDialog(page).getByRole('button', { name: 'Install Light Pack' }).click()

  await expect(settings(page).locator('.appearance-status')).toContainText(
    'Added 2 themes from Light Pack.',
  )
  await expect(swatch(page, 'One light')).toBeChecked()
  await expect(swatch(page, 'Two light')).not.toBeChecked()
  await expect(schemeRadio(page, 'Light')).toBeChecked()

  await settings(page).getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(swatch(page, 'One light')).toHaveCount(0)
  await expect(swatch(page, 'Two light')).toHaveCount(0)
  await expect(schemeRadio(page, 'System')).toBeChecked()
  await expect(swatch(page, 'Moss dark')).toBeChecked()
  await expect(settings(page).getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0)
  expect(await tokens(page)).toEqual(prior)
  await page.reload()
  await expectHome(page)
  expect(await tokens(page)).toEqual(prior)
})

test('another window saving a theme retires Undo, so it cannot erase that theme', async ({
  context,
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await signIn(page, 'twowindows')
  await stubOpenVsx(page, () => results(entry('pack', 'Pack')), {
    ...manifestOf('pack', [{ label: 'One', uiTheme: 'vs-dark', path: './one.json' }]),
    [fileOf('pack', 'one.json')]: JSON.stringify({ colors: { 'editor.background': '#111122' } }),
  })
  await openAppearance(page)
  const search = await openAdd(page)
  await search.fill('pack')
  await addDialog(page).getByRole('button', { name: 'Install Pack' }).click()
  const undo = settings(page).getByRole('button', { name: 'Undo', exact: true })
  await expect(undo).toBeVisible()

  const second = await context.newPage()
  await second.emulateMedia({ colorScheme: 'dark' })
  await second.goto(await page.evaluate(() => location.href))
  await expectHome(second)
  await openAppearance(second)
  await createButton(second).click()
  const panel = panelOf(second)
  await panel.getByRole('textbox', { name: 'Theme name' }).fill('Later')
  await panel.getByRole('button', { name: 'Create theme', exact: true }).click()
  await expect(panel).toHaveCount(0)

  await expect(swatch(page, 'Later dark')).toBeVisible()
  await expect(undo).toHaveCount(0)
  await expect(settings(page).locator('.appearance-status')).toHaveText('Added 1 theme from Pack.')
  await expect(swatch(page, 'One dark')).toBeVisible()
  await second.close()
})

test('search survives a stale answer, an outage, no results, and a file too large', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await signIn(page, 'searching')
  let release: (body: string) => void = () => {}
  let online = false
  const requests = await stubOpenVsx(
    page,
    (query) => {
      if (query === 'slow') return { hold: new Promise<string>((resolve) => (release = resolve)) }
      if (query === 'nothing') return results()
      if (query === 'outage' && !online) return { status: 500 }
      if (query === 'big') return results(entry('big', 'Big Pack'))
      if (query === 'outage') return results(entry('back', 'Back Pack'))
      return results(entry('fast', 'Fast Pack'))
    },
    {
      ...manifestOf('slow', [{ path: './a.json' }]),
      ...manifestOf('fast', [{ path: './a.json' }]),
      ...manifestOf('back', [{ path: './a.json' }]),
      ...manifestOf('big', [{ path: './a.json' }]),
      [fileOf('big', 'a.json')]: JSON.stringify({
        colors: { 'editor.background': '#101010' },
        padding: 'x'.repeat(1024 * 1024),
      }),
    },
  )
  await openAppearance(page)
  const search = await openAdd(page)
  const dialog = addDialog(page)

  await search.fill('slow')
  await expect.poll(() => requests.some((path) => path.includes('query=slow'))).toBe(true)
  await search.fill('fast')
  await expect(dialog.getByRole('button', { name: 'Install Fast Pack' })).toBeVisible()
  release(results(entry('slow', 'Slow Pack')))
  await page.waitForTimeout(200)
  await expect(dialog.getByText('Slow Pack')).toHaveCount(0)

  await search.fill('nothing')
  await expect(dialog.getByRole('status')).toHaveText('No color themes match nothing.')

  await search.fill('outage')
  await expect(dialog.getByRole('alert')).toContainText('Open VSX could not provide that.')
  online = true
  await dialog.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Install Back Pack' })).toBeVisible()
  await expect(dialog.getByRole('alert')).toHaveCount(0)

  await search.fill('big')
  await dialog.getByRole('button', { name: 'Install Big Pack' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('Big Pack has no theme Huddle can read.')
  await expect(dialog.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0)

  await dialog.getByRole('combobox', { name: 'Sort' }).selectOption('rating')
  await expect.poll(() => requests.some((path) => path.includes('sortBy=rating'))).toBe(true)

  await dialog.getByRole('button', { name: 'Nord', exact: true }).click()
  await expect(search).toHaveValue('Nord')
  await expect.poll(() => requests.some((path) => path.includes('query=Nord'))).toBe(true)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(swatch(page, 'Big Pack dark')).toHaveCount(0)
})

test('installing again changes nothing, and a taken name is reported rather than overwritten', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await signIn(page, 'again')
  await stubOpenVsx(page, () => results(entry('pack', 'Pack')), {
    ...manifestOf('pack', [
      { label: 'Keep', uiTheme: 'vs-dark', path: './keep.json' },
      { label: 'Moss', uiTheme: 'vs-dark', path: './moss.json' },
    ]),
    [fileOf('pack', 'keep.json')]: JSON.stringify({ colors: { 'editor.background': '#111122' } }),
    [fileOf('pack', 'moss.json')]: JSON.stringify({ colors: { 'editor.background': '#112211' } }),
  })
  await openAppearance(page)
  const status = settings(page).getByRole('status')
  for (const wanted of [
    'Added 1 theme from Pack. 1 name already held different colors. Undo',
    'Pack is already here. 1 name already held different colors.',
  ]) {
    const search = await openAdd(page)
    await search.fill('pack')
    await addDialog(page).getByRole('button', { name: 'Install Pack' }).click()
    await expect(addDialog(page)).toHaveCount(0)
    await expect(status).toHaveText(wanted)
  }
  await expect(page.getByRole('radio', { name: /^Keep / })).toHaveCount(1)
  await expect(page.getByRole('radio', { name: /^Moss / })).toHaveCount(2)
  await expect(swatch(page, 'Keep dark')).toBeChecked()
})

test('Edit restores on Cancel, renames in place, and keeps the other side', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await signIn(page, 'editing')
  await openAppearance(page)
  const create = panelOf(page)
  const edit = page.getByRole('dialog', { name: 'Edit theme', exact: true })
  const editButton = (name: string) =>
    settings(page).getByRole('button', { name: `Edit ${name}`, exact: true })
  const openEdit = async (name: string) => {
    await settings(page)
      .getByRole('button', { name: `More actions for ${name}`, exact: true })
      .click()
    await editButton(name).click()
  }
  const background = edit.getByRole('textbox', { name: 'Background', exact: true })
  const accent = edit.getByRole('textbox', { name: 'Accent', exact: true })
  const nameField = edit.getByRole('textbox', { name: 'Theme name' })
  const save = edit.getByRole('button', { name: 'Save theme', exact: true })
  const stored = () => page.evaluate((key) => localStorage.getItem(key), APPEARANCE_KEYS.themes)

  await expect(settings(page).getByRole('button', { name: /^Edit / })).toHaveCount(0)
  await createButton(page).click()
  await create.getByRole('textbox', { name: 'Theme name' }).fill('Aurora')
  await create.getByRole('textbox', { name: 'Background', exact: true }).fill('#101820')
  await create.getByRole('textbox', { name: 'Accent', exact: true }).fill('#ff0066')
  await create.getByRole('button', { name: 'Create theme', exact: true }).click()
  await expect(create).toHaveCount(0)
  await expect(editButton('Moss')).toHaveCount(0)
  const original = await stored()
  const painted = await tokens(page)

  await openEdit('Aurora')
  await expect(nameField).toHaveValue('Aurora')
  await expect(background).toHaveValue('#101820')
  await expect(accent).toHaveValue('#ff0066')
  await accent.fill('#00cc88')
  await expect.poll(async () => (await tokens(page)).accent).toBe('rgb(0, 204, 136)')
  await edit.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(edit).toHaveCount(0)
  expect(await tokens(page)).toEqual(painted)
  expect(await stored()).toBe(original)
  await expect(
    settings(page).getByRole('button', { name: 'More actions for Aurora', exact: true }),
  ).toBeFocused()

  await openEdit('Aurora')
  await nameField.fill('huddle')
  await save.click()
  await expect(edit.getByRole('alert')).toHaveText('Another theme is already named Huddle.')
  await nameField.fill('Boreal')
  await edit.getByRole('radio', { name: 'Light', exact: true }).check()
  await expect(edit).toContainText('This theme has no light version yet. Saving adds one.')
  await edit.getByRole('radio', { name: 'Dark', exact: true }).check()
  await expect(background).toHaveValue('#101820')
  await accent.fill('#00cc88')
  await save.click()
  await expect(edit).toHaveCount(0)
  await expect(swatch(page, 'Boreal dark')).toBeChecked()
  await expect(swatch(page, 'Boreal light')).toHaveCount(0)
  await expect(swatch(page, 'Aurora dark')).toHaveCount(0)
  expect((await tokens(page)).accent).toBe('rgb(0, 204, 136)')
  const id = JSON.parse((await stored()) ?? '[]')[0].id
  expect(id).toBe(JSON.parse(original ?? '[]')[0].id)

  await openEdit('Boreal')
  await edit.getByRole('radio', { name: 'Light', exact: true }).check()
  await expect(background).not.toHaveValue('#101820')
  await background.fill('#fdf6e3')
  await save.click()
  await expect(edit).toHaveCount(0)
  await expect(swatch(page, 'Boreal light')).toBeChecked()
  await expect(schemeRadio(page, 'System')).toBeChecked()
  await expect(settings(page).getByRole('status')).toHaveText(
    'Boreal shows when your system is light.',
  )
  expect((await rootStyle(page)).background).toBe('rgb(16, 24, 32)')

  await openEdit('Boreal')
  await expect(background).toHaveValue('#101820')
  await background.fill('not a color')
  await edit.getByRole('radio', { name: 'Light', exact: true }).check()
  await expect(background).toHaveValue('#fdf6e3')
  await save.click()
  await expect(edit.getByRole('alert')).toHaveText(
    'The dark version needs a fix. Background is not a color.',
  )
  await edit.getByRole('radio', { name: 'Dark', exact: true }).check()
  await expect(background).toHaveValue('not a color')
  await background.fill('#202830')
  await edit.getByRole('radio', { name: 'Light', exact: true }).check()
  await save.click()
  await expect(edit).toHaveCount(0)
  const both = JSON.parse((await stored()) ?? '[]')[0]
  expect(both.dark.background).toBe('#202830')
  expect(both.light.background).toBe('#fdf6e3')
  expect(both.id).toBe(id)
})
