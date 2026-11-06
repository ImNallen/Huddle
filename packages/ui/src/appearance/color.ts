export type ColorLiteral = string & { readonly __brand: 'ColorLiteral' }
export type Rgba = { r: number; g: number; b: number; a: number }
export type Oklch = { l: number; c: number; h: number }

const clamp = (value: number, low = 0, high = 1) => Math.min(high, Math.max(low, value))
const toLinear = (channel: number) =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
const toGamma = (channel: number) =>
  channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055

function oklabToLinear(l: number, a: number, b: number) {
  const long = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const medium = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const short = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short,
    -1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short,
    -0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short,
  ] as const
}

function oklabToRgb(l: number, a: number, b: number, alpha: number): Rgba {
  const [red, green, blue] = oklabToLinear(l, a, b).map((linear) => toGamma(Math.max(0, linear)))
  return clampRgba({ r: red ?? 0, g: green ?? 0, b: blue ?? 0, a: alpha })
}

function hslToRgb(hue: number, saturation: number, lightness: number, alpha: number): Rgba {
  const channel = (offset: number) => {
    const k = (offset + hue / 30) % 12
    const chroma = saturation * Math.min(lightness, 1 - lightness)
    return lightness - chroma * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }
  return { r: channel(0), g: channel(8), b: channel(4), a: alpha }
}

const ARGUMENT = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:%|deg)?`
const SEPARATOR = String.raw`(?:\s*,\s*|\s+)`
const FUNCTION = new RegExp(
  String.raw`^(rgba?|hsla?|oklch|oklab)\(\s*(${ARGUMENT})${SEPARATOR}(${ARGUMENT})${SEPARATOR}(${ARGUMENT})(?:\s*[,/]\s*(${ARGUMENT}))?\s*\)$`,
)
const MAX_LITERAL_LENGTH = 64

const isPercent = (text: string) => text.endsWith('%')
const scaled = (text: string, whole: number) =>
  isPercent(text) ? (parseFloat(text) / 100) * whole : parseFloat(text)
const hasDegrees = (text: string) => text.endsWith('deg')

function parseFunction(text: string): Rgba | null {
  const match = text.match(FUNCTION)
  if (!match) return null
  const [, name, first = '', second = '', third = '', fourth] = match
  if (fourth && hasDegrees(fourth)) return null
  const alpha = fourth === undefined ? 1 : clamp(scaled(fourth, 1))
  if (name === 'rgb' || name === 'rgba') {
    if ([first, second, third].some(hasDegrees)) return null
    return {
      r: clamp(scaled(first, 255) / 255),
      g: clamp(scaled(second, 255) / 255),
      b: clamp(scaled(third, 255) / 255),
      a: alpha,
    }
  }
  if (name === 'hsl' || name === 'hsla') {
    if (isPercent(first) || hasDegrees(second) || hasDegrees(third)) return null
    const hue = ((parseFloat(first) % 360) + 360) % 360
    return hslToRgb(hue, clamp(scaled(second, 100) / 100), clamp(scaled(third, 100) / 100), alpha)
  }
  if (hasDegrees(first) || hasDegrees(second)) return null
  const lightness = clamp(scaled(first, 1))
  if (name === 'oklch') {
    if (isPercent(third)) return null
    const chroma = Math.max(0, scaled(second, 0.4))
    return fitChroma({ l: lightness, c: chroma, h: (parseFloat(third) * Math.PI) / 180 }, alpha)
  }
  if (hasDegrees(third)) return null
  return oklabToRgb(lightness, scaled(second, 0.4), scaled(third, 0.4), alpha)
}

function parseHex(text: string): Rgba | null {
  if (!/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(text)) return null
  const digits = text.slice(1)
  const full = digits.length < 6 ? [...digits].map((digit) => digit + digit).join('') : digits
  const channel = (start: number) => parseInt(full.slice(start, start + 2), 16) / 255
  return { r: channel(0), g: channel(2), b: channel(4), a: full.length === 8 ? channel(6) : 1 }
}

const clampRgba = ({ r, g, b, a }: Rgba): Rgba => ({
  r: clamp(r),
  g: clamp(g),
  b: clamp(b),
  a: clamp(a),
})

function fitChroma({ l, c, h }: Oklch, alpha: number): Rgba {
  if (l <= 0) return { r: 0, g: 0, b: 0, a: alpha }
  if (l >= 1) return { r: 1, g: 1, b: 1, a: alpha }
  let chroma = c
  for (let step = 0; step < 32; step++) {
    const inGamut = oklabToLinear(l, chroma * Math.cos(h), chroma * Math.sin(h)).every(
      (linear) => linear >= -0.0005 && linear <= 1.0005,
    )
    if (inGamut) break
    chroma *= 0.93
  }
  return oklabToRgb(l, chroma * Math.cos(h), chroma * Math.sin(h), alpha)
}

function serialize({ r, g, b, a }: Rgba) {
  const bytes = [r, g, b].map((channel) => Math.round(channel * 255))
  const alpha = Math.round(a * 1000) / 1000
  if (alpha >= 1) return `#${bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
  return `rgb(${bytes.join(' ')} / ${alpha})`
}

function parseRgba(text: string): Rgba | null {
  if (text.length > MAX_LITERAL_LENGTH) return null
  const trimmed = text.trim().toLowerCase()
  return trimmed.startsWith('#') ? parseHex(trimmed) : parseFunction(trimmed)
}

/** The only place a ColorLiteral is minted. The output is built from parsed numbers, never from the
 *  input text, so it can only ever be `#rrggbb` or `rgb(r g b / a)`. */
export function parseColor(text: string): ColorLiteral | null {
  const rgba = parseRgba(text)
  return rgba && (serialize(rgba) as ColorLiteral)
}

/** For colors written in this package's source, where a bad value is a programming error. */
export function color(text: string): ColorLiteral {
  const literal = parseColor(text)
  if (!literal) throw new Error(`Not a color: ${text}`)
  return literal
}

export function rgbaOf(literal: ColorLiteral): Rgba {
  const rgba = parseRgba(literal)
  if (!rgba) throw new Error(`Not a color: ${literal}`)
  return rgba
}

export const isTranslucent = (literal: ColorLiteral) => literal.startsWith('rgb(')

export function flatten(top: ColorLiteral, ground: ColorLiteral): ColorLiteral {
  return color(serialize(over(rgbaOf(top), rgbaOf(ground))))
}

export function over(top: Rgba, ground: Rgba): Rgba {
  const mix = (front: number, back: number) => front * top.a + back * (1 - top.a)
  return { r: mix(top.r, ground.r), g: mix(top.g, ground.g), b: mix(top.b, ground.b), a: 1 }
}

export function luminance({ r, g, b }: Rgba) {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
}

const OPAQUE_WHITE: Rgba = { r: 1, g: 1, b: 1, a: 1 }

/** WCAG contrast of `top` over `ground`. Alpha composites first, so a translucent text color and a
 *  wash over a surface both compare as the color a person actually sees. */
export function contrast(top: Rgba, ground: Rgba) {
  const base = ground.a < 1 ? over(ground, OPAQUE_WHITE) : ground
  const first = luminance(top.a < 1 ? over(top, base) : top)
  const second = luminance(base)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

export function toOklch({ r, g, b }: Rgba): Oklch {
  const [red, green, blue] = [toLinear(r), toLinear(g), toLinear(b)] as const
  const long = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue)
  const medium = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue)
  const short = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue)
  const l = 0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short
  const a = 1.9779984951 * long - 2.428592205 * medium + 0.4505937099 * short
  const b2 = 0.0259040371 * long + 0.7827717662 * medium - 0.808675766 * short
  return { l, c: Math.hypot(a, b2), h: Math.atan2(b2, a) }
}

/** Fits sRGB by reducing chroma, so a shifted color keeps its lightness and hue. */
export function fromOklch(value: Oklch, alpha = 1): ColorLiteral {
  return color(serialize(fitChroma(value, alpha)))
}

export function withAlpha(literal: ColorLiteral, alpha: number): ColorLiteral {
  return color(serialize({ ...rgbaOf(literal), a: alpha }))
}
