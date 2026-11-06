import { luminance, parseColor, rgbaOf, type ColorLiteral } from './color'
import {
  guardOverrides,
  isTokenName,
  SEEDS,
  seatBackground,
  TOKEN_NAMES,
  TOKENS,
  type Half,
  type Scheme,
  type TokenName,
} from './palette'
import type { HalfSet } from './builtins'

export type NewTheme = { name: string } & HalfSet
export type ParsedFile =
  | { ok: true; theme: NewTheme; notes: string[] }
  | { ok: false; error: string }

export const MAX_FILE_BYTES = 1024 * 1024
export const TOO_LARGE = 'This file is larger than 1 MB, so it is not a theme.'
export const MAX_THEME_NAME = 48
const FORMATS = 'Use a T3 Code theme file or a VS Code color theme.'

class Refusal extends Error {}

/** Removes comments and trailing commas from JSONC. It tracks strings, so `"#fff // not a comment"`
 *  and a URL inside a value stay whole. */
function stripJsonc(text: string) {
  let out = ''
  let inString = false
  for (let index = 0; index < text.length; index++) {
    const char = text.charAt(index)
    const next = text.charAt(index + 1)
    if (inString) {
      out += char
      if (char === '\\') out += text.charAt(++index)
      else if (char === '"') inString = false
    } else if (char === '"') {
      inString = true
      out += char
    } else if (char === '/' && next === '/') {
      while (index < text.length && text.charAt(index) !== '\n') index++
      out += '\n'
    } else if (char === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2)
      index = end === -1 ? text.length : end + 1
    } else if (char === ',') {
      const rest = text.slice(index + 1)
      const following = nextMeaningfulChar(rest)
      if (following !== '}' && following !== ']') out += char
    } else {
      out += char
    }
  }
  return out
}

function nextMeaningfulChar(text: string) {
  let index = 0
  while (index < text.length) {
    const char = text.charAt(index)
    if (/\s/.test(char)) index++
    else if (text.startsWith('//', index)) {
      const end = text.indexOf('\n', index)
      index = end === -1 ? text.length : end + 1
    } else if (text.startsWith('/*', index)) {
      const end = text.indexOf('*/', index + 2)
      index = end === -1 ? text.length : end + 2
    } else return char
  }
  return ''
}

export const parseJsonc = (text: string): unknown => JSON.parse(stripJsonc(text))

type Json = Record<string, unknown>
const isJson = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const records = (value: unknown) => (isJson(value) ? value : undefined)

function literalOf(role: string, value: unknown): ColorLiteral {
  const literal = typeof value === 'string' ? parseColor(value) : null
  if (!literal) throw new Refusal(`${role} is not a color Huddle can use.`)
  return literal
}

function strictLiterals(colors: Record<string, unknown>) {
  const out: Record<string, ColorLiteral> = {}
  for (const [role, value] of Object.entries(colors)) out[role] = literalOf(role, value)
  return out
}

// VS Code themes write `#0000` to mean "draw nothing", such as Rosé Pine's `panel.border`. Huddle's
// floor plan is built from those roles, so a fully transparent value counts as absent and derives.
const firstOf = (colors: Record<string, ColorLiteral>, keys: readonly string[]) =>
  keys.flatMap((key) => colors[key] ?? []).find((literal) => rgbaOf(literal).a > 0)

function huddleOverrides(section: unknown): Half['overrides'] {
  const overrides: Half['overrides'] = {}
  for (const [name, value] of Object.entries(records(section) ?? {})) {
    if (isTokenName(name)) overrides[name] = literalOf(name, value)
  }
  return overrides
}

function mapHalf(
  colors: Record<string, ColorLiteral>,
  scheme: Scheme,
  keysOf: (name: TokenName) => readonly string[],
  extra: Half['overrides'] = {},
): Half {
  const seeds = SEEDS[scheme]
  const background = firstOf(colors, keysOf('bg')) ?? seeds.background
  const accent = firstOf(colors, keysOf('accent')) ?? seeds.accent
  const overrides: Half['overrides'] = {}
  for (const name of TOKEN_NAMES) {
    if (name === 'bg' || name === 'accent') continue
    const value = firstOf(colors, keysOf(name))
    if (value) overrides[name] = value
  }
  return { background, accent, overrides: { ...overrides, ...extra } }
}

const schemeFromGround = (ground: ColorLiteral | undefined, fallback: Scheme): Scheme =>
  ground ? (luminance(rgbaOf(ground)) > 0.4 ? 'light' : 'dark') : fallback

function parseT3(file: Json): { halves: Partial<Record<Scheme, Half>> } {
  const colors = strictLiterals(records(file.colors) ?? {})
  const variants = records(file.variants) ?? {}
  const huddle = records(file.huddle) ?? {}
  const keysOf = (name: TokenName) => TOKENS[name].t3
  const halves: Partial<Record<Scheme, Half>> = {}
  if (Object.keys(colors).length) {
    const stated =
      file.appearance === 'light' || file.appearance === 'dark' ? file.appearance : null
    const scheme = stated ?? schemeFromGround(firstOf(colors, TOKENS.bg.t3), 'dark')
    halves[scheme] = mapHalf(colors, scheme, keysOf, huddleOverrides(huddle[scheme]))
  }
  for (const scheme of ['light', 'dark'] as const) {
    const variant = records(variants[scheme])
    if (!variant) continue
    // T3 replaces a half whole from its variant and inherits nothing from `colors`.
    halves[scheme] = mapHalf(
      strictLiterals(variant),
      scheme,
      keysOf,
      huddleOverrides(huddle[scheme]),
    )
  }
  return { halves }
}

function parseVsCode(file: Json): { halves: Partial<Record<Scheme, Half>> } {
  const raw = records(file.colors) ?? {}
  const mapped = new Set(TOKEN_NAMES.flatMap((name) => TOKENS[name].vscode))
  const colors: Record<string, ColorLiteral> = {}
  for (const [key, value] of Object.entries(raw)) {
    // VS Code reads `null` as "use the default color".
    if (mapped.has(key) && value !== null) colors[key] = literalOf(key, value)
  }
  const ground = firstOf(colors, TOKENS.bg.vscode)
  const scheme: Scheme =
    file.type === 'dark' || file.type === 'hc-black'
      ? 'dark'
      : file.type === 'light' || file.type === 'hc-light'
        ? 'light'
        : schemeFromGround(ground, 'dark')
  return { halves: { [scheme]: mapHalf(colors, scheme, (name) => TOKENS[name].vscode) } }
}

function detect(file: Json): 't3' | 'vscode' | null {
  if (file.appearance !== undefined || file.variants !== undefined) return 't3'
  if (typeof file.version === 'number') return 't3'
  const dotted = Object.keys(records(file.colors) ?? {}).some((key) => key.includes('.'))
  if (file.tokenColors !== undefined || file.type !== undefined || dotted) return 'vscode'
  return null
}

export function themeOfHalves(
  name: string,
  { light, dark }: Partial<Record<Scheme, Half>>,
): NewTheme | null {
  if (light && dark) return { name, light, dark }
  if (light) return { name, light }
  if (dark) return { name, dark }
  return null
}

function plural(count: number) {
  return `${count} ${count === 1 ? 'color' : 'colors'}`
}

/** A file is untrusted, so one bad value in a role Huddle would read refuses the whole file, and the
 *  error names the role. */
export function parseThemeFile(text: string, fileName?: string): ParsedFile {
  if (new TextEncoder().encode(text).length > MAX_FILE_BYTES) {
    return { ok: false, error: TOO_LARGE }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stripJsonc(text))
  } catch {
    return { ok: false, error: `This is not valid JSON. ${FORMATS}` }
  }
  const format = isJson(parsed) ? detect(parsed) : null
  if (!isJson(parsed) || !format) {
    return { ok: false, error: `This is not a theme file. ${FORMATS}` }
  }
  try {
    const { halves } = format === 't3' ? parseT3(parsed) : parseVsCode(parsed)
    const stated = typeof parsed.name === 'string' ? parsed.name.trim() : ''
    const fallback = fileName?.replace(/\.[^.]+$/, '').trim() || 'Imported theme'
    const name = (stated || fallback).slice(0, MAX_THEME_NAME)
    let adjusted = 0
    const guarded: Partial<Record<Scheme, Half>> = {}
    for (const scheme of ['light', 'dark'] as const) {
      const half = halves[scheme]
      if (!half) continue
      const result = guardOverrides(half, scheme)
      guarded[scheme] = result.half
      adjusted += result.adjusted.length
      if (seatBackground(half.background, scheme) !== half.background) adjusted += 1
    }
    const theme = themeOfHalves(name, guarded)
    if (!theme) return { ok: false, error: `This file has no colors. ${FORMATS}` }
    const sides = theme.light && theme.dark ? 'light and dark' : theme.light ? 'light' : 'dark'
    const adjustment = adjusted ? ` Adjusted ${plural(adjusted)} for readable text.` : ''
    return { ok: true, theme, notes: [`Adds ${name}, ${sides}.${adjustment}`] }
  } catch (failure) {
    if (failure instanceof Refusal) return { ok: false, error: failure.message }
    throw failure
  }
}

function exportHalf(half: Half) {
  const colors: Record<string, ColorLiteral> = { canvas: half.background, accent: half.accent }
  const huddle: Partial<Record<TokenName, ColorLiteral>> = {}
  for (const name of TOKEN_NAMES) {
    const value = half.overrides[name]
    if (!value) continue
    const keys: readonly string[] = TOKENS[name].t3
    const key = name === 'bg' || name === 'accent' ? null : keys.find((k) => !(k in colors))
    if (key) colors[key] = value
    else huddle[name] = value
  }
  return { colors, huddle }
}

/** Writes T3's shape. Tokens with no free T3 key go in a top-level `huddle` object, so nothing is
 *  lost when the file comes back here. */
export function themeFileText(theme: NewTheme): string {
  const primary: Scheme = theme.dark ? 'dark' : 'light'
  const secondary: Scheme = primary === 'dark' ? 'light' : 'dark'
  const first = theme[primary]
  if (!first) throw new Error('A theme has at least one half.')
  const main = exportHalf(first)
  const other = theme[secondary]
  const second = other && exportHalf(other)
  const huddle = {
    ...(Object.keys(main.huddle).length ? { [primary]: main.huddle } : {}),
    ...(second && Object.keys(second.huddle).length ? { [secondary]: second.huddle } : {}),
  }
  return JSON.stringify(
    {
      version: 1,
      name: theme.name,
      appearance: primary,
      colors: main.colors,
      ...(second ? { variants: { [secondary]: second.colors } } : {}),
      ...(Object.keys(huddle).length ? { huddle } : {}),
    },
    null,
    2,
  )
}
