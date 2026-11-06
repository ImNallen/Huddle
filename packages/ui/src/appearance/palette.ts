import {
  color,
  contrast,
  flatten,
  fromOklch,
  isTranslucent,
  luminance,
  over,
  rgbaOf,
  toOklch,
  withAlpha,
  type ColorLiteral,
  type Oklch,
  type Rgba,
} from './color'

export type Scheme = 'light' | 'dark'
export const SCHEMES: readonly Scheme[] = ['light', 'dark']

export type Half = {
  background: ColorLiteral
  accent: ColorLiteral
  overrides: Partial<Record<TokenName, ColorLiteral>>
}

type Ground = string | readonly [wash: string, under: string]
type Guard = { grounds: readonly Ground[]; min: number }
type Context = {
  scheme: Scheme
  seed: Pick<Half, 'background' | 'accent'>
  read: (name: string) => ColorLiteral
}
type TokenRow = {
  label: string
  group: 'Surfaces' | 'Washes and lines' | 'Action' | 'Text' | 'Status' | 'Access screens'
  t3: readonly string[]
  vscode: readonly string[]
  derive: (context: Context) => ColorLiteral
  guard?: Guard
  wash?: true
}

const INK: Record<Scheme, ColorLiteral> = { dark: color('#ffffff'), light: color('#18181b') }
const END: Record<Scheme, ColorLiteral> = { dark: color('#ffffff'), light: color('#000000') }
const WHITE = color('#ffffff')
const BLACK = color('#000000')
const WHITE_OR_BLACK_FLOOR = 4.5
const SEAT_FLOOR = 4.75

const shift = (value: Oklch, by: number): Oklch => ({
  ...value,
  l: Math.min(1, Math.max(0, value.l + by)),
})
const oklchOf = (literal: ColorLiteral) => toOklch(rgbaOf(literal))

const SURFACE_STEP = {
  chrome: { dark: -0.04, light: -0.022 },
  sidebar: { dark: -0.04, light: -0.005 },
  panel: { dark: 0.03, light: -0.022 },
  'rail-tile': { dark: 0.05, light: 0.01 },
  raised: { dark: 0.05, light: 0.01 },
  card: { dark: 0.012, light: 0.01 },
  input: { dark: 0.05, light: -0.022 },
  secondary: { dark: 0.09, light: -0.07 },
  'secondary-hover': { dark: 0.14, light: -0.12 },
  tile: { dark: 0.12, light: -0.07 },
  'access-card': { dark: 0.05, light: 0.01 },
  'access-input': { dark: 0.09, light: -0.022 },
} as const
const WASH_ALPHA = {
  hover: { dark: 0.05, light: 0.05 },
  selected: { dark: 0.09, light: 0.08 },
  'message-hover': { dark: 0.03, light: 0.03 },
  line: { dark: 0.06, light: 0.11 },
  'line-strong': { dark: 0.12, light: 0.18 },
  'scroll-thumb': { dark: 0.16, light: 0.22 },
} as const
const MENTION_ALPHA = { dark: 0.28, light: 0.12 } as const

const surface =
  (name: keyof typeof SURFACE_STEP) =>
  ({ scheme, read }: Context) =>
    fromOklch(shift(oklchOf(read('bg')), SURFACE_STEP[name][scheme]))
const wash =
  (name: keyof typeof WASH_ALPHA) =>
  ({ scheme }: Context) =>
    withAlpha(INK[scheme], WASH_ALPHA[name][scheme])
const ink =
  (lightness: Record<Scheme, number>) =>
  ({ scheme, read }: Context) => {
    const ground = oklchOf(read('bg'))
    return fromOklch({ l: lightness[scheme], c: Math.min(ground.c, 0.02), h: ground.h })
  }
const accentInk =
  (lightness: Record<Scheme, number>) =>
  ({ scheme, read }: Context) => {
    const accent = oklchOf(read('accent'))
    return fromOklch({ l: lightness[scheme], c: Math.min(accent.c, 0.16), h: accent.h })
  }
const statusInk =
  (hue: number, lightness: Record<Scheme, number>) =>
  ({ scheme }: Context) =>
    fromOklch({ l: lightness[scheme], c: 0.16, h: (hue * Math.PI) / 180 })
const onAccentIsWhite = (read: Context['read']) => read('on-accent') === WHITE

function mentionWash({ scheme, read }: Context) {
  const end = rgbaOf(END[scheme])
  const ground = rgbaOf(read('bg'))
  for (let alpha = MENTION_ALPHA[scheme]; alpha > 0.02; alpha -= 0.02) {
    const candidate = withAlpha(read('accent'), alpha)
    if (contrast(end, over(rgbaOf(candidate), ground)) >= SEAT_FLOOR) return candidate
  }
  return withAlpha(read('accent'), 0.02)
}

export const BODY_GROUNDS = [
  'bg',
  'chrome',
  'sidebar',
  'panel',
  'raised',
  'card',
  'input',
  'rail-tile',
  'access-card',
  'access-input',
  ['hover', 'sidebar'],
  ['hover', 'panel'],
  ['selected', 'sidebar'],
  ['selected', 'panel'],
  ['message-hover', 'bg'],
  ['mention-bg', 'bg'],
] as const satisfies readonly Ground[]
const CONTROL_GROUNDS = [...BODY_GROUNDS, 'secondary', 'secondary-hover', 'tile'] as const

// Table order is resolve order, and a row reads only rows above it.
export const TOKENS = {
  bg: {
    label: 'Chat ground',
    group: 'Surfaces',
    t3: ['canvas', 'surface'],
    vscode: ['editor.background', 'sideBar.background'],
    derive: ({ seed, scheme }) => seatBackground(seed.background, scheme),
  },
  chrome: {
    label: 'Shell',
    group: 'Surfaces',
    t3: ['chrome', 'toolbar'],
    vscode: ['titleBar.activeBackground', 'activityBar.background'],
    derive: surface('chrome'),
  },
  sidebar: {
    label: 'Channel column',
    group: 'Surfaces',
    t3: ['sidebar'],
    vscode: ['sideBar.background'],
    derive: surface('sidebar'),
  },
  panel: {
    label: 'Account panel',
    group: 'Surfaces',
    t3: ['surface'],
    vscode: ['panel.background'],
    derive: surface('panel'),
  },
  'rail-tile': {
    label: 'Rail tile',
    group: 'Surfaces',
    t3: ['surfaceRaised'],
    vscode: ['sideBarSectionHeader.background'],
    derive: surface('rail-tile'),
  },
  raised: {
    label: 'Raised surface',
    group: 'Surfaces',
    t3: ['surfaceOverlay', 'surfaceRaised'],
    vscode: ['menu.background', 'editorWidget.background'],
    derive: surface('raised'),
  },
  card: {
    label: 'Card',
    group: 'Surfaces',
    t3: ['surface'],
    vscode: ['editorWidget.background'],
    derive: surface('card'),
  },
  input: {
    label: 'Composer',
    group: 'Surfaces',
    t3: ['messageSurface'],
    vscode: ['input.background'],
    derive: surface('input'),
  },
  secondary: {
    label: 'Secondary fill',
    group: 'Surfaces',
    t3: ['secondary'],
    vscode: ['button.secondaryBackground'],
    derive: surface('secondary'),
  },
  'secondary-hover': {
    label: 'Secondary hover',
    group: 'Surfaces',
    t3: [],
    vscode: ['button.secondaryHoverBackground'],
    derive: surface('secondary-hover'),
  },
  tile: {
    label: 'Icon tile',
    group: 'Surfaces',
    t3: ['muted'],
    vscode: ['badge.background'],
    derive: surface('tile'),
  },
  'access-card': {
    label: 'Access card',
    group: 'Access screens',
    t3: [],
    vscode: [],
    derive: surface('access-card'),
  },
  'access-input': {
    label: 'Access field',
    group: 'Access screens',
    t3: [],
    vscode: [],
    derive: surface('access-input'),
  },
  hover: {
    label: 'Hover wash',
    group: 'Washes and lines',
    t3: ['sidebarRowHover'],
    vscode: ['list.hoverBackground'],
    derive: wash('hover'),
    wash: true,
  },
  selected: {
    label: 'Selected wash',
    group: 'Washes and lines',
    t3: ['sidebarRowSelected', 'sidebarRowActive'],
    vscode: ['list.activeSelectionBackground'],
    derive: wash('selected'),
    wash: true,
  },
  'message-hover': {
    label: 'Message hover',
    group: 'Washes and lines',
    t3: [],
    vscode: ['editor.lineHighlightBackground'],
    derive: wash('message-hover'),
    wash: true,
  },
  line: {
    label: 'Hairline',
    group: 'Washes and lines',
    t3: ['border'],
    vscode: ['panel.border', 'sideBar.border'],
    derive: wash('line'),
    wash: true,
  },
  'line-strong': {
    label: 'Field border',
    group: 'Washes and lines',
    t3: ['input'],
    vscode: ['input.border', 'contrastBorder'],
    derive: wash('line-strong'),
    wash: true,
  },
  'scroll-thumb': {
    label: 'Scroll thumb',
    group: 'Washes and lines',
    t3: [],
    vscode: ['scrollbarSlider.background'],
    derive: wash('scroll-thumb'),
    wash: true,
  },
  accent: {
    label: 'Accent fill',
    group: 'Action',
    t3: ['accent', 'focus'],
    vscode: ['button.background', 'focusBorder'],
    derive: ({ seed, read }) => flatten(seed.accent, read('bg')),
  },
  'on-accent': {
    label: 'On accent',
    group: 'Action',
    t3: ['accentForeground'],
    vscode: ['button.foreground'],
    derive: ({ read }) =>
      contrast(rgbaOf(WHITE), rgbaOf(read('accent'))) >= WHITE_OR_BLACK_FLOOR ? WHITE : BLACK,
    guard: { grounds: ['accent'], min: 4.5 },
  },
  'accent-hover': {
    label: 'Accent hover',
    group: 'Action',
    t3: ['messageActionHover'],
    vscode: ['button.hoverBackground'],
    derive: ({ read }) =>
      fromOklch(shift(oklchOf(read('accent')), onAccentIsWhite(read) ? -0.05 : 0.05)),
    guard: { grounds: ['on-accent'], min: 4.5 },
  },
  focus: {
    label: 'Focus ring',
    group: 'Action',
    t3: ['focus'],
    vscode: ['focusBorder'],
    derive: ({ read }) => read('accent'),
    guard: { grounds: ['bg', 'panel', 'raised', 'sidebar', 'input', 'card'], min: 3 },
  },
  'mention-bg': {
    label: 'Mention fill',
    group: 'Action',
    t3: [],
    vscode: [],
    derive: mentionWash,
    wash: true,
  },
  text: {
    label: 'Message text',
    group: 'Text',
    t3: ['text'],
    vscode: ['editor.foreground', 'foreground'],
    derive: ink({ dark: 0.97, light: 0.28 }),
    guard: { grounds: CONTROL_GROUNDS, min: 4.5 },
  },
  strong: {
    label: 'Names and headings',
    group: 'Text',
    t3: ['messageForeground'],
    vscode: [],
    derive: ink({ dark: 1, light: 0.2 }),
    guard: { grounds: BODY_GROUNDS, min: 4.5 },
  },
  muted: {
    label: 'Muted text',
    group: 'Text',
    t3: ['textMuted'],
    vscode: ['descriptionForeground'],
    derive: ink({ dark: 0.74, light: 0.47 }),
    guard: { grounds: BODY_GROUNDS, min: 4.5 },
  },
  faint: {
    label: 'Timestamps',
    group: 'Text',
    t3: ['secondaryLabel'],
    vscode: ['editorLineNumber.foreground'],
    derive: ink({ dark: 0.66, light: 0.47 }),
    guard: { grounds: BODY_GROUNDS, min: 4.5 },
  },
  placeholder: {
    label: 'Placeholder',
    group: 'Text',
    t3: ['placeholder'],
    vscode: ['input.placeholderForeground'],
    derive: ink({ dark: 0.66, light: 0.47 }),
    guard: { grounds: BODY_GROUNDS, min: 4.5 },
  },
  link: {
    label: 'Link',
    group: 'Text',
    t3: ['updateForeground'],
    vscode: ['textLink.foreground'],
    derive: accentInk({ dark: 0.76, light: 0.46 }),
    guard: { grounds: BODY_GROUNDS, min: 4.5 },
  },
  mention: {
    label: 'Mention text',
    group: 'Text',
    t3: [],
    vscode: ['textLink.activeForeground'],
    derive: accentInk({ dark: 0.86, light: 0.4 }),
    guard: { grounds: BODY_GROUNDS, min: 4.5 },
  },
  green: {
    label: 'Connected',
    group: 'Status',
    t3: [],
    vscode: ['gitDecoration.addedResourceForeground'],
    derive: statusInk(150, { dark: 0.68, light: 0.47 }),
    guard: { grounds: BODY_GROUNDS, min: 4.5 },
  },
  amber: {
    label: 'Waiting',
    group: 'Status',
    t3: ['warningForeground'],
    vscode: ['editorWarning.foreground'],
    derive: statusInk(75, { dark: 0.84, light: 0.5 }),
    guard: { grounds: BODY_GROUNDS, min: 4.5 },
  },
  danger: {
    label: 'Danger',
    group: 'Status',
    t3: ['errorForeground'],
    vscode: ['errorForeground', 'editorError.foreground'],
    derive: statusInk(25, { dark: 0.72, light: 0.48 }),
    guard: { grounds: BODY_GROUNDS, min: 4.5 },
  },
  'danger-fill': {
    label: 'Count badge',
    group: 'Status',
    t3: ['error'],
    vscode: ['statusBarItem.errorBackground'],
    derive: () => fromOklch({ l: 0.56, c: 0.2, h: (25 * Math.PI) / 180 }),
    guard: { grounds: ['on-accent'], min: 4.5 },
  },
  'access-field-from': {
    label: 'Access gradient start',
    group: 'Access screens',
    t3: [],
    vscode: [],
    derive: ({ read }) => {
      const accent = oklchOf(read('accent'))
      const l = onAccentIsWhite(read) ? 0.28 : 0.9
      return fromOklch({ ...accent, l, c: Math.min(accent.c, 0.14) })
    },
    guard: { grounds: ['on-accent'], min: 4.5 },
  },
  'access-field-to': {
    label: 'Access gradient end',
    group: 'Access screens',
    t3: [],
    vscode: [],
    derive: ({ read }) => {
      const accent = oklchOf(read('accent'))
      const l = onAccentIsWhite(read) ? Math.min(accent.l, 0.5) : Math.max(accent.l, 0.8)
      return fromOklch({ ...accent, l })
    },
    guard: { grounds: ['on-accent'], min: 4.5 },
  },
} satisfies Record<string, TokenRow>

export type TokenName = keyof typeof TOKENS
export type Palette = Record<TokenName, ColorLiteral>
export const TOKEN_NAMES = Object.keys(TOKENS) as TokenName[]
export const isTokenName = (name: string): name is TokenName => Object.hasOwn(TOKENS, name)
const row = (name: TokenName): TokenRow => TOKENS[name]

export const SEEDS: Record<Scheme, { background: ColorLiteral; accent: ColorLiteral }> = {
  dark: { background: color('#0a0a0a'), accent: color('#346bf1') },
  light: { background: color('#fcfcfc'), accent: color('#1b4ed8') },
}

function groundRgba(ground: Ground, read: (name: string) => ColorLiteral): Rgba {
  if (typeof ground === 'string') return rgbaOf(read(ground))
  const [top, under] = ground
  return over(rgbaOf(read(top)), rgbaOf(read(under)))
}

const SEAT_SURFACES = Object.keys(SURFACE_STEP) as (keyof typeof SURFACE_STEP)[]

/** Moves the background toward the scheme's end until pure white or black reaches 4.75:1 on every
 *  ground, so every text row below has somewhere to land. */
export function seatBackground(background: ColorLiteral, scheme: Scheme): ColorLiteral {
  const opaque = flatten(background, SEEDS[scheme].background)
  const end = rgbaOf(END[scheme])
  const selected = rgbaOf(withAlpha(INK[scheme], WASH_ALPHA.selected[scheme]))
  const direction = scheme === 'dark' ? -1 : 1
  let current = oklchOf(opaque)
  let candidate = opaque
  for (let step = 0; step < 120; step++) {
    const position = current
    const surfaces = SEAT_SURFACES.map((name) =>
      rgbaOf(fromOklch(shift(position, SURFACE_STEP[name][scheme]))),
    )
    const grounds = [rgbaOf(candidate), ...surfaces].flatMap((ground) => [
      ground,
      over(selected, ground),
    ])
    if (grounds.every((ground) => contrast(end, ground) >= SEAT_FLOOR)) return candidate
    current = shift(current, direction * 0.01)
    candidate = fromOklch(current)
  }
  return candidate
}

function fit(start: ColorLiteral, guard: Guard, read: (name: string) => ColorLiteral) {
  const grounds = guard.grounds.map((ground) => groundRgba(ground, read))
  // Candidates are serialized before they are measured, so the check runs on the written 8-bit value.
  const passes = (candidate: ColorLiteral) =>
    grounds.every((ground) => contrast(rgbaOf(candidate), ground) >= guard.min)
  const first = grounds[0]
  if (!first || passes(start)) return start
  const rgba = rgbaOf(start)
  const preferred = luminance(over(rgba, first)) >= luminance(first) ? 1 : -1
  for (const direction of [preferred, -preferred]) {
    for (const alpha of rgba.a < 1 ? [rgba.a, 1] : [1]) {
      let current = toOklch(rgba)
      for (let step = 0; step < 110; step++) {
        const candidate = fromOklch(current, alpha)
        if (passes(candidate)) return candidate
        current = shift(current, direction * 0.01)
      }
    }
  }
  return preferred > 0 ? WHITE : BLACK
}

function walk(half: Half, scheme: Scheme, guardChosen: boolean) {
  const palette: Partial<Record<string, ColorLiteral>> = {}
  const adjusted: TokenName[] = []
  const read = (name: string) => {
    const value = palette[name]
    if (!value) throw new Error(`Token ${name} is read before its row.`)
    return value
  }
  const context: Context = { scheme, seed: half, read }
  for (const name of TOKEN_NAMES) {
    const { derive, guard } = row(name)
    const chosen = half.overrides[name]
    if (!chosen) {
      palette[name] = guard ? fit(derive(context), guard, read) : derive(context)
    } else if (guard && guardChosen) {
      const fitted = fit(chosen, guard, read)
      if (fitted !== chosen) adjusted.push(name)
      palette[name] = fitted
    } else {
      palette[name] = chosen
    }
  }
  // Every key was just written, in the one loop above.
  return { palette: palette as Palette, adjusted }
}

/** Walks TOKENS in order. Every guarded token not in overrides meets its floor against the final
 *  palette. An override stays verbatim, which is the Advanced exception. */
export function resolveHalf(half: Half, scheme: Scheme): Palette {
  return walk(half, scheme, false).palette
}

const endInkFails = (palette: Palette, scheme: Scheme, ground: Ground) => {
  const read = (name: string) => palette[name as TokenName]
  return contrast(rgbaOf(END[scheme]), groundRgba(ground, read)) < WHITE_OR_BLACK_FLOOR
}

/** Guards overrides themselves, because a file is not a person's choice. A ground that no text could
 *  read on returns to its derived value, and a text color moves until it reads. */
export function guardOverrides(half: Half, scheme: Scheme): { half: Half; adjusted: TokenName[] } {
  const adjusted = new Set<TokenName>()
  const overrides = { ...half.overrides }
  for (const name of TOKEN_NAMES) {
    const chosen = overrides[name]
    if (!chosen || row(name).wash || !isTranslucent(chosen)) continue
    const seat = seatBackground(half.background, scheme)
    overrides[name] = flatten(chosen, name === 'bg' ? seat : (overrides.bg ?? seat))
  }
  for (let round = 0; round < TOKEN_NAMES.length; round++) {
    const palette = resolveHalf({ ...half, overrides }, scheme)
    const failing = CONTROL_GROUNDS.filter((ground) => endInkFails(palette, scheme, ground))
    const blamed = failing
      .flatMap((ground) => (typeof ground === 'string' ? [ground] : [...ground]))
      .filter((name) => overrides[name] !== undefined)
    if (failing.length && !blamed.length && overrides.bg) blamed.push('bg')
    if (!blamed.length) break
    for (const name of blamed) {
      delete overrides[name]
      adjusted.add(name)
    }
  }
  const guarded = walk({ ...half, overrides }, scheme, true)
  for (const name of guarded.adjusted) {
    overrides[name] = guarded.palette[name]
    adjusted.add(name)
  }
  return { half: { ...half, overrides }, adjusted: [...adjusted] }
}

export function guardReading(palette: Palette, name: TokenName) {
  const guard = row(name).guard
  if (!guard) return null
  const read = (token: string) => palette[token as TokenName]
  const value = rgbaOf(palette[name])
  const readings = guard.grounds.map((ground) => ({
    ground,
    ratio: contrast(value, groundRgba(ground, read)),
  }))
  const worst = readings.reduce((low, reading) => (reading.ratio < low.ratio ? reading : low))
  const under = typeof worst.ground === 'string' ? worst.ground : worst.ground[1]
  const label = isTokenName(under) ? row(under).label : under
  return { ratio: worst.ratio, on: label, min: guard.min }
}
