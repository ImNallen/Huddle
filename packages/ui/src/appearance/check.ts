import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { contrast, over, parseColor, rgbaOf, type ColorLiteral, type Rgba } from './color'
import {
  BODY_GROUNDS,
  guardOverrides,
  guardReading,
  resolveHalf,
  seatBackground,
  SEEDS,
  TOKEN_NAMES,
  TOKENS,
  type Half,
  type Palette,
  type Scheme,
  type TokenName,
} from './palette'
import { BUILT_IN_THEMES } from './builtins'
import { extensionPath, pairVariants, variantsOf } from './openVsx'
import { parseThemeFile, themeFileText, type NewTheme } from './themeFile'
import { cssOf, STORAGE_KEYS } from './store'

const failures: string[] = []
let checks = 0
function expect(ok: boolean, message: string) {
  checks++
  if (!ok) failures.push(message)
}
function equal(actual: unknown, wanted: unknown, message: string) {
  expect(
    JSON.stringify(actual) === JSON.stringify(wanted),
    `${message}: got ${JSON.stringify(actual)?.slice(0, 200)}, wanted ${JSON.stringify(wanted)?.slice(0, 200)}`,
  )
}
const literal = (text: string) => {
  const value = parseColor(text)
  if (!value) throw new Error(`Expected a color: ${text}`)
  return value
}

const ACCEPTED: readonly (readonly [string, string])[] = [
  ['#FFF', '#ffffff'],
  ['#0f08', 'rgb(0 255 0 / 0.533)'],
  ['#1b4ed8', '#1b4ed8'],
  ['#1b4ed880', 'rgb(27 78 216 / 0.502)'],
  ['#1b4ed8ff', '#1b4ed8'],
  ['rgb(10, 10, 10)', '#0a0a0a'],
  ['rgba(255, 255, 255, 0.05)', 'rgb(255 255 255 / 0.05)'],
  ['rgb(255 255 255 / 0.05)', 'rgb(255 255 255 / 0.05)'],
  ['rgb(255 255 255 / 5%)', 'rgb(255 255 255 / 0.05)'],
  ['rgb(100% 0% 0%)', '#ff0000'],
  ['RGB(1 2 3)', '#010203'],
  ['hsl(0 100% 50%)', '#ff0000'],
  ['hsl(120deg 100% 50%)', '#00ff00'],
  ['hsla(240, 100%, 50%, 0.5)', 'rgb(0 0 255 / 0.5)'],
  ['oklch(1 0 0)', '#ffffff'],
  ['oklch(0% 0 0)', '#000000'],
  ['oklch(0.97 0.01 157deg)', '#f0f7f2'],
  ['oklab(0.5 0 0)', '#636363'],
  ['oklab(100% 0 0 / 0.5)', 'rgb(255 255 255 / 0.5)'],
  ['  #abc  ', '#aabbcc'],
]
const REFUSED = [
  'url(x)',
  'url(https://evil.test/x)',
  'var(--a)',
  '#fff;}body{display:none}',
  '#fff;',
  '#ffff;}',
  'red',
  'transparent',
  'calc(1)',
  'rgb(0 0 0)x',
  'rgb(0 0)',
  'rgb(0 0 0 0)',
  'rgb(calc(1) 0 0)',
  'rgb(1deg 0 0)',
  'rgb(1e2 0 0)',
  'hsl(1% 0% 0%)',
  'oklch(none 0 0)',
  'oklch(0.5 0.1 10%)',
  '#12',
  '#12345',
  '#1234567',
  '#ggg',
  'expression(alert(1))',
  '',
  ' ',
  `rgb(${'1'.repeat(80)} 0 0)`,
]
const ATTACKS = [
  ...REFUSED,
  'rgb(0 0 0 / 1e-1)',
  'rgb(0 0 0 / 5%)',
  'hsl(0 0% 0%)',
  '#FFFFFF',
  '#fff',
]

function checkParser() {
  for (const [input, output] of ACCEPTED) equal(parseColor(input), output, `parseColor(${input})`)
  for (const input of REFUSED) equal(parseColor(input), null, `parseColor(${input})`)
  for (const [input] of ACCEPTED) {
    const once = parseColor(input)
    equal(once && parseColor(once), once, `parseColor is a fixed point for ${input}`)
  }
}

const groundOf = (palette: Palette, ground: (typeof BODY_GROUNDS)[number]): Rgba =>
  typeof ground === 'string'
    ? rgbaOf(palette[ground])
    : over(rgbaOf(palette[ground[0]]), rgbaOf(palette[ground[1]]))

function checkGuards(palette: Palette, label: string) {
  for (const name of TOKEN_NAMES) {
    const reading = guardReading(palette, name)
    if (!reading) continue
    expect(
      Math.round(reading.ratio * 1000) >= reading.min * 1000,
      `${label}: ${name} ${palette[name]} reaches ${reading.ratio.toFixed(3)} on ${reading.on}, under ${reading.min}`,
    )
  }
  for (const fill of [
    'accent-hover',
    'danger-fill',
    'access-field-from',
    'access-field-to',
  ] as const) {
    const ratio = contrast(rgbaOf(palette['on-accent']), rgbaOf(palette[fill]))
    expect(ratio >= 4.5, `${label}: on-accent reaches ${ratio.toFixed(3)} on ${fill}`)
  }
  for (const ground of BODY_GROUNDS) {
    const ratio = contrast(rgbaOf(palette.text), groundOf(palette, ground))
    expect(ratio >= 4.5, `${label}: text reaches ${ratio.toFixed(3)} on ${String(ground)}`)
  }
}

function readChatCss() {
  const css = readFileSync(new URL('../chat.css', import.meta.url), 'utf8')
  const palette = /\[data-palette='huddle'\] \{\n([\s\S]*?)\n\}/.exec(css)?.[1]
  if (!palette) throw new Error('chat.css lost its palette rule.')
  const light: Record<string, ColorLiteral> = {}
  const dark: Record<string, ColorLiteral> = {}
  for (const [, name = '', first = '', second = ''] of palette.matchAll(
    /^ {2}--([a-z-]+): light-dark\((#[0-9a-f]+|rgb\([^)]*\)), (#[0-9a-f]+|rgb\([^)]*\))\);$/gm,
  )) {
    light[name] = literal(first)
    dark[name] = literal(second)
  }
  equal(
    palette.split('\n').length,
    Object.keys(light).length,
    'every palette line in chat.css is one light-dark() declaration',
  )
  return { light: light as Palette, dark: dark as Palette, css }
}

function checkHuddleCss() {
  const { light, dark, css } = readChatCss()
  equal(
    Object.keys(light).sort(),
    [...TOKEN_NAMES].sort(),
    'chat.css declares exactly the tokens in TOKENS',
  )
  if (Object.keys(light).length !== TOKEN_NAMES.length) return
  checkGuards(light, 'Huddle light')
  checkGuards(dark, 'Huddle dark')
  expect(
    !/prefers-color-scheme/.test(css),
    'chat.css branches on the scheme only with light-dark()',
  )
}

function checkBuiltIns() {
  for (const theme of BUILT_IN_THEMES) {
    for (const scheme of ['light', 'dark'] as const) {
      const half = theme[scheme]
      expect(Boolean(half), `${theme.name} has a ${scheme} half`)
      if (half) checkGuards(resolveHalf(half, scheme), `${theme.name} ${scheme}`)
    }
  }
}

const SEED_BACKGROUNDS: Record<Scheme, readonly string[]> = {
  dark: [
    '#000000',
    '#0a0a0a',
    '#ffffff',
    '#808080',
    '#002b36',
    '#282a36',
    '#1e1e2e',
    '#2e3440',
    '#ff00ff',
    '#0000ff',
    '#ffff00',
    '#3c3c3c',
    '#646464',
  ],
  light: [
    '#ffffff',
    '#fcfcfc',
    '#000000',
    '#808080',
    '#fdf6e3',
    '#eff1f5',
    '#ff00ff',
    '#ffff00',
    '#0000ff',
    '#b0b0b0',
    '#c8c8c8',
  ],
}
const SEED_ACCENTS = [
  '#346bf1',
  '#1b4ed8',
  '#ffff00',
  '#808080',
  '#000000',
  '#ffffff',
  '#ff0000',
  '#00ff00',
  '#767676',
  '#777777',
]

function checkDerivation() {
  for (const scheme of ['light', 'dark'] as const) {
    for (const background of SEED_BACKGROUNDS[scheme]) {
      for (const accent of SEED_ACCENTS) {
        const half: Half = {
          background: literal(background),
          accent: literal(accent),
          overrides: {},
        }
        checkGuards(resolveHalf(half, scheme), `${scheme} ${background} with ${accent}`)
      }
    }
  }
  for (const seat of ['#002b36', '#282a36', '#2e3440']) {
    equal(seatBackground(literal(seat), 'dark'), seat, `${seat} stays where it is as a dark seed`)
  }
  for (const seat of ['#fdf6e3', '#eff1f5']) {
    equal(seatBackground(literal(seat), 'light'), seat, `${seat} stays where it is as a light seed`)
  }
  const verbatim = resolveHalf({ ...SEEDS.dark, overrides: { muted: literal('#111111') } }, 'dark')
  equal(verbatim.muted, '#111111', 'an Advanced override stays verbatim')
  const guarded = guardOverrides(
    { ...SEEDS.dark, overrides: { muted: literal('#111111') } },
    'dark',
  )
  equal(guarded.adjusted, ['muted'], 'a file override that cannot be read is adjusted')
  checkGuards(resolveHalf(guarded.half, 'dark'), 'guarded dark file')
  const bright = guardOverrides({ ...SEEDS.dark, overrides: { panel: literal('#808080') } }, 'dark')
  equal(bright.adjusted, ['panel'], 'a file ground no text can read on returns to derived')
  checkGuards(resolveHalf(bright.half, 'dark'), 'guarded dark ground')
}

type FakeSheet = { css: string; replaceSync(text: string): void }
function runBoot(stored: Record<string, string>, fails = false) {
  const script = readFileSync(new URL('../../public/appearance-boot.js', import.meta.url), 'utf8')
  const dataset: Record<string, string> = {}
  const document: {
    documentElement: { dataset: typeof dataset }
    adoptedStyleSheets: FakeSheet[]
  } = { documentElement: { dataset }, adoptedStyleSheets: [] }
  runInNewContext(script, {
    document,
    CSSStyleSheet: class implements FakeSheet {
      css = ''
      replaceSync(text: string) {
        this.css = text
      }
    },
    localStorage: {
      getItem(key: string) {
        if (fails) throw new Error('blocked')
        return stored[key] ?? null
      },
    },
  })
  return { scheme: dataset.scheme, css: document.adoptedStyleSheets[0]?.css ?? '' }
}

function checkBoot() {
  equal(STORAGE_KEYS.mode, 'huddle.appearance.mode', 'boot reads the store mode key')
  equal(STORAGE_KEYS.paint, 'huddle.appearance.paint.v1', 'boot reads the store paint key')
  const clay = BUILT_IN_THEMES.find((theme) => theme.name === 'Clay')
  if (!clay?.dark || !clay.light) throw new Error('Clay is gone.')
  const dark = resolveHalf(clay.dark, 'dark')
  const light = resolveHalf(clay.light, 'light')

  equal(runBoot({}), { scheme: undefined, css: '' }, 'nothing stored follows the OS')
  equal(runBoot({}, true), { scheme: undefined, css: '' }, 'a throwing store follows the OS')
  equal(
    runBoot({ [STORAGE_KEYS.mode]: 'light' }).scheme,
    'light',
    'a stored mode sets the attribute',
  )
  equal(runBoot({ [STORAGE_KEYS.mode]: 'pink' }).scheme, undefined, 'a bad mode is ignored')
  equal(runBoot({ [STORAGE_KEYS.paint]: '{nope' }).css, '', 'a corrupt cache paints nothing')
  for (const paint of [{ dark }, { light }, { light, dark }]) {
    const text = JSON.stringify(paint)
    equal(runBoot({ [STORAGE_KEYS.paint]: text }).css, cssOf(paint), 'boot CSS equals cssOf')
  }
  for (const theme of BUILT_IN_THEMES) {
    for (const scheme of ['light', 'dark'] as const) {
      const half = theme[scheme]
      if (!half) continue
      const paint = { [scheme]: resolveHalf(half, scheme) }
      equal(
        runBoot({ [STORAGE_KEYS.paint]: JSON.stringify(paint) }).css,
        cssOf(paint),
        `boot accepts every literal in ${theme.name} ${scheme}`,
      )
    }
  }
  for (const text of [...ACCEPTED.map(([input]) => literal(input)), 'rgb(0 0 0 / 0)']) {
    const paint = JSON.stringify({ dark: { bg: text } })
    expect(
      runBoot({ [STORAGE_KEYS.paint]: paint }).css.includes(`--bg:${text};`),
      `boot accepts the parseColor output ${text}`,
    )
  }
  for (const attack of ATTACKS) {
    const paint = JSON.stringify({ dark: { bg: attack } })
    equal(runBoot({ [STORAGE_KEYS.paint]: paint }).css, '', `boot refuses ${attack}`)
  }
  equal(
    runBoot({ [STORAGE_KEYS.paint]: JSON.stringify({ dark: { 'bg}body{': '#000000' } }) }).css,
    '',
    'boot refuses a hostile token name',
  )
}

const refused = (text: string, role: string) => {
  const parsed = parseThemeFile(text)
  expect(!parsed.ok, `refuses ${text.slice(0, 40)}`)
  if (!parsed.ok) expect(parsed.error.includes(role), `${parsed.error} names ${role}`)
}
const accepted = (text: string, fileName?: string) => {
  const parsed = parseThemeFile(text, fileName)
  if (!parsed.ok) throw new Error(`Expected to accept ${text.slice(0, 60)}: ${parsed.error}`)
  return parsed
}

function checkFiles() {
  const single = accepted(
    JSON.stringify({
      version: 1,
      name: 'Aurora',
      appearance: 'light',
      colors: { canvas: 'oklch(0.97 0.01 157)', accent: '#1b4ed8', surface: '#ffffff' },
    }),
  )
  equal(single.theme.name, 'Aurora', 'T3 file keeps its name')
  expect(Boolean(single.theme.light) && !single.theme.dark, 'T3 single half stays single')
  equal(single.theme.light?.background, '#f0f7f2', 'T3 canvas is the seed background')
  equal(single.theme.light?.overrides.panel, '#ffffff', 'T3 surface maps to the panel')
  equal(single.notes, ['Adds Aurora, light.'], 'T3 note names the theme')

  const variants = accepted(
    JSON.stringify({
      version: 1,
      name: 'Aurora',
      appearance: 'light',
      colors: { canvas: '#fcfcfc', accent: '#1b4ed8', sidebar: '#fafafa' },
      variants: { dark: { canvas: '#0a0a0a' } },
    }),
  )
  equal(variants.theme.dark?.overrides, {}, 'a T3 variant inherits nothing from colors')
  equal(variants.notes, ['Adds Aurora, light and dark.'], 'two halves say so')

  const jsonc = accepted(
    `// Night Owl
     {
       /* block */ "name": "Night // Owl",
       "type": "dark",
       "colors": {
         "editor.background": "#011627", // ground
         "button.background": "#7e57c2",
         "unmapped.key": "url(https://evil.test/x)",
       },
       "tokenColors": [],
     }`,
  )
  equal(jsonc.theme.name, 'Night // Owl', 'a comment-like string survives the JSONC scanner')
  equal(jsonc.theme.dark?.background, '#011627', 'VS Code editor background is the seed')
  equal(jsonc.theme.dark?.accent, '#7e57c2', 'VS Code button background is the accent')

  const borderless = accepted(
    JSON.stringify({
      type: 'dark',
      colors: {
        'editor.background': '#191724',
        'panel.border': '#0000',
        'sideBar.border': '#26233a',
        'input.border': '#00000000',
      },
    }),
  )
  equal(
    borderless.theme.dark?.overrides.line,
    '#26233a',
    'a transparent border falls through to the next key',
  )
  expect(
    borderless.theme.dark?.overrides['line-strong'] === undefined,
    'a transparent border with no other key derives',
  )
  const titled = accepted(
    JSON.stringify({
      type: 'dark',
      colors: { 'editor.background': '#1e1e2e', 'sideBarTitle.foreground': '#cba6f7' },
    }),
  )
  expect(
    titled.theme.dark?.overrides.strong === undefined,
    'a sidebar title color does not recolor every heading',
  )

  const untyped = accepted(
    JSON.stringify({ colors: { 'editor.background': '#fdf6e3' } }),
    'sol.json',
  )
  expect(Boolean(untyped.theme.light), 'a VS Code file with no type picks by luminance')
  equal(untyped.theme.name, 'sol', 'a missing name falls back to the file name')
  const nameless = accepted(JSON.stringify({ colors: { 'editor.background': '#002b36' } }))
  expect(Boolean(nameless.theme.dark), 'a dark background with no type is dark')
  equal(nameless.theme.name, 'Imported theme', 'no name and no file says so')
  const contrastTheme = accepted(JSON.stringify({ type: 'hc-black', colors: {} }))
  expect(Boolean(contrastTheme.theme.dark), 'hc-black is dark')
  const contrastLight = accepted(JSON.stringify({ type: 'hc-light', colors: {} }))
  expect(Boolean(contrastLight.theme.light), 'hc-light is light')
  equal(
    accepted(JSON.stringify({ name: 'x'.repeat(60), type: 'dark', colors: {} })).theme.name.length,
    48,
    'names are cut to 48 characters',
  )

  refused(JSON.stringify({ version: 1, colors: { canvas: 'url(https://evil.test/x)' } }), 'canvas')
  refused(JSON.stringify({ version: 1, colors: { terminalRed: 'red' } }), 'terminalRed')
  refused(JSON.stringify({ version: 1, colors: { accent: '#fff;}' } }), 'accent')
  refused(JSON.stringify({ variants: { dark: { canvas: 'var(--x)' } } }), 'canvas')
  refused(
    JSON.stringify({ type: 'dark', colors: { 'editor.background': 'url(x)' } }),
    'editor.background',
  )
  refused(
    JSON.stringify({
      version: 1,
      colors: { canvas: '#000000' },
      huddle: { dark: { card: 'url(x)' } },
    }),
    'card',
  )
  refused('{ "version": 1 }', 'no colors')
  refused('{ "name": "nothing" }', 'theme file')
  refused('[]', 'theme file')
  refused('{', 'JSON')
  refused(JSON.stringify({ version: 1, colors: { canvas: 'x'.repeat(1024 * 1024) } }), '1 MB')
  const proto = parseThemeFile(
    '{"version":1,"colors":{"canvas":"#000000"},"huddle":{"dark":{"constructor":"url(x)"}}}',
  )
  expect(proto.ok, 'a token name is an own key of the table, not an inherited one')

  const everything = TOKEN_NAMES.filter((name) => name !== 'bg' && name !== 'accent')
  const clay = BUILT_IN_THEMES.find((theme) => theme.name === 'Indigo')
  if (!clay?.dark || !clay.light) throw new Error('Indigo is gone.')
  for (const theme of [
    { name: clay.name, light: clay.light, dark: clay.dark },
    { name: 'One side', dark: clay.dark },
    { name: 'Other side', light: clay.light },
  ]) {
    const first = themeFileText(theme)
    const again = accepted(first)
    equal(
      themeFileText(again.theme),
      first,
      `themeFileText then parse is a fixed point: ${theme.name}`,
    )
    for (const scheme of ['light', 'dark'] as const) {
      const half = theme[scheme]
      const back = again.theme[scheme]
      if (half && back) {
        equal(
          resolveHalf(back, scheme),
          resolveHalf(half, scheme),
          `${theme.name} ${scheme} round trip`,
        )
      }
    }
  }
  equal(everything.length, TOKEN_NAMES.length - 2, 'bg and accent are the only seeds')
}

function checkRegistry() {
  const manifest = 'extension/package.json'
  for (const [from, relative, wanted] of [
    [manifest, './themes/a.json', 'extension/themes/a.json'],
    [manifest, 'themes//b.json', 'extension/themes/b.json'],
    ['extension/themes/a.json', '../base/c.json', 'extension/base/c.json'],
    [manifest, '../secret.json', null],
    ['extension/themes/a.json', '../../secret.json', null],
    [manifest, '/etc/passwd.json', null],
    [manifest, 'themes/..%2f..%2fsecret.json', null],
    [manifest, 'themes\\..\\secret.json', null],
    [manifest, 'https://evil.test/a.json', null],
    [manifest, 'a.json?x=1', null],
    [manifest, '.', null],
  ] as const) {
    equal(extensionPath(from, relative), wanted, `extensionPath ${from} + ${relative}`)
  }

  equal(variantsOf(null), [], 'a manifest of null has no variants')
  equal(variantsOf({ contributes: { themes: 'x' } }), [], 'themes must be a list')
  equal(
    variantsOf({
      contributes: {
        themes: [
          { label: 'Good', uiTheme: 'hc-black', path: './a.json' },
          { label: '%key%', uiTheme: 'vs', path: './b.jsonc' },
          { label: 'Native', path: './c.tmTheme' },
          { label: 'Outside', path: '../d.json' },
          { label: 'No path' },
          null,
        ],
      },
    }),
    [
      { label: 'Good', path: 'extension/a.json', scheme: 'dark' },
      { label: null, path: 'extension/b.jsonc', scheme: 'light' },
    ],
    'variantsOf keeps JSON files inside the extension',
  )
  const many = Array.from({ length: 200 }, (_, index) => ({ path: `./${index}.json` }))
  equal(variantsOf({ contributes: { themes: many } }).length, 40, 'variants are capped')

  const half = (background: string) => {
    const literal = parseColor(background)
    if (!literal) throw new Error(`Not a color: ${background}`)
    return { background: literal, accent: literal, overrides: {} }
  }
  const dark = half('#101010')
  const light = half('#f0f0f0')
  const names = (themes: readonly NewTheme[]) =>
    themes.map((theme) => `${theme.name}:${theme.light ? 'L' : ''}${theme.dark ? 'D' : ''}`)
  equal(
    names(
      pairVariants([
        { name: 'Foo Dark', dark },
        { name: 'Foo Light', light },
      ]),
    ),
    ['Foo:LD'],
    'one light and one dark pair',
  )
  equal(
    names(
      pairVariants([
        { name: 'Foo (Light)', light },
        { name: 'Foo - Dark', dark },
      ]),
    ),
    ['Foo:LD'],
    'punctuation left by a removed word goes with it',
  )
  equal(
    names(
      pairVariants([
        { name: 'Foo Dark', dark },
        { name: 'Foo Dark Soft', dark: half('#202020') },
        { name: 'Foo Light', light },
      ]),
    ),
    ['Foo:LD', 'Foo Dark Soft:D'],
    'each family pairs on its own',
  )
  equal(
    names(
      pairVariants([
        { name: 'Foo Dark', dark },
        { name: 'Foo Dark 2', dark: half('#202020') },
        { name: 'Foo dark', dark: half('#303030') },
        { name: 'Foo Light', light },
      ]),
    ),
    ['Foo Dark:D', 'Foo Dark 2:D', 'Foo dark:D', 'Foo Light:L'],
    'an ambiguous family stays apart',
  )
  equal(
    names(
      pairVariants([
        { name: 'Pine', dark },
        { name: 'Pine (no italics)', dark },
        { name: 'Dawn', light },
      ]),
    ),
    ['Pine:D', 'Dawn:L'],
    'an identical palette drops out',
  )
  equal(names(pairVariants([{ name: 'Dark', dark }])), ['Dark:D'], 'a name with no family stays')

  const nulls = accepted(
    JSON.stringify({
      type: 'dark',
      colors: { 'editor.background': '#101010', 'button.background': null },
    }),
  )
  equal(nulls.theme.dark?.background, '#101010', 'a null color means the default in VS Code')
}

function checkTableOrder() {
  const names: readonly string[] = TOKEN_NAMES
  for (const name of TOKEN_NAMES) {
    const guard = (TOKENS[name] as { guard?: { grounds: readonly (string | readonly string[])[] } })
      .guard
    for (const ground of guard?.grounds ?? []) {
      for (const read of typeof ground === 'string' ? [ground] : ground) {
        expect(
          names.indexOf(read) >= 0 && names.indexOf(read) < names.indexOf(name),
          `${name} reads ${read}, which is not above it`,
        )
      }
    }
  }
  const keys = TOKEN_NAMES.flatMap((name): TokenName[] => [name])
  equal(keys.length, 37, 'TOKENS has one row per color token')
}

checkParser()
checkHuddleCss()
checkBuiltIns()
checkDerivation()
checkBoot()
checkFiles()
checkRegistry()
checkTableOrder()

if (failures.length) {
  console.error(`Appearance check failed, ${failures.length} of ${checks}:`)
  for (const failure of failures.slice(0, 40)) console.error(`  ${failure}`)
  process.exit(1)
}
console.log(`Appearance check passed, ${checks} checks.`)
