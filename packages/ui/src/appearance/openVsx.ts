import { z } from 'zod'
import type { Scheme } from './palette'
import { MAX_FILE_BYTES, parseJsonc, parseThemeFile, type NewTheme } from './themeFile'

const ORIGIN = 'https://open-vsx.org'
const SEARCH_BYTES = 512 * 1024
const MANIFEST_BYTES = 256 * 1024
const TIMEOUT_MS = 10_000
const RESULTS = 16
const MAX_VARIANTS = 40
const MAX_INCLUDES = 8

// Relevance leads because a person has typed a name. Sorted by downloads, "rose pine" opens on
// Dracula Remastered.
export const SORTS = [
  { value: 'relevance', label: 'Most relevant' },
  { value: 'downloadCount', label: 'Most downloaded' },
  { value: 'rating', label: 'Best rated' },
  { value: 'timestamp', label: 'Newest' },
] as const
export type Sort = (typeof SORTS)[number]['value']
export const POPULAR = ['Dracula', 'Catppuccin', 'Nord', 'Tokyo Night'] as const

export type Variant = { label: string | null; path: string; scheme: Scheme | null }
export type ThemeExtension = {
  namespace: string
  name: string
  version: string
  title: string
  description: string
  downloads: number
  icon: string | null
  variants: readonly Variant[]
}
export type LoadedThemes = { themes: readonly NewTheme[]; unreadable: number }

const Identifier = z.string().regex(/^[A-Za-z0-9][\w.+-]*$/)
const SearchEntry = z.object({
  namespace: Identifier,
  name: Identifier,
  version: Identifier,
  displayName: z.string().optional(),
  description: z.string().optional(),
  downloadCount: z.number().optional(),
  deprecated: z.boolean().optional(),
  files: z.object({ icon: z.string().optional() }).optional(),
})
type SearchEntry = z.infer<typeof SearchEntry>
const SearchBody = z.object({ extensions: z.array(z.unknown()) })

const SCHEME_OF: Readonly<Record<string, Scheme>> = {
  vs: 'light',
  'hc-light': 'light',
  'vs-dark': 'dark',
  'hc-black': 'dark',
}

const records = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/** Keeps a path a manifest names inside its own `extension/` folder. A manifest is untrusted, and
 *  this is the only way one of its strings becomes part of a URL. */
export function extensionPath(fromFile: string, relative: string) {
  if (relative.startsWith('/')) return null
  const parts = fromFile.split('/').slice(0, -1)
  for (const part of relative.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length <= 1) return null
      parts.pop()
    } else if (/[\\%?#:]/.test(part)) {
      return null
    } else {
      parts.push(part)
    }
  }
  return parts[0] === 'extension' && parts.length > 1 ? parts.join('/') : null
}

/** The color themes a manifest declares, past the ones Huddle can't read, such as `.tmTheme`. */
export function variantsOf(manifest: unknown): Variant[] {
  const themes = records(records(manifest).contributes).themes
  if (!Array.isArray(themes)) return []
  return themes.slice(0, MAX_VARIANTS).flatMap((item: unknown): Variant[] => {
    const { label, path, uiTheme } = records(item)
    if (typeof path !== 'string' || !/\.jsonc?$/i.test(path)) return []
    const inside = extensionPath('extension/package.json', path)
    if (!inside) return []
    // `%name%` is a key into a translation file Huddle doesn't read.
    const named = typeof label === 'string' && label.trim() && !label.startsWith('%')
    return [
      {
        label: named ? label.trim() : null,
        path: inside,
        scheme: typeof uiTheme === 'string' ? (SCHEME_OF[uiTheme] ?? null) : null,
      },
    ]
  })
}

function familyOf(name: string) {
  return name
    .replace(/\b(?:light|dark)\b/gi, ' ')
    .replace(/\(\s*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—:|]+|[\s\-–—:|]+$/g, '')
}

/** One card per palette. Identical palettes drop out, such as a "no italics" twin, and a family with
 *  exactly one light and one dark variant becomes one two-sided theme, as T3 does. */
export function pairVariants(themes: readonly NewTheme[]): NewTheme[] {
  const seen = new Set<string>()
  const distinct = themes.filter((theme) => {
    const key = JSON.stringify([theme.light, theme.dark])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const families = new Map<string, NewTheme[]>()
  for (const theme of distinct) {
    const family = familyOf(theme.name)
    if (family === theme.name || !/[\p{L}\p{N}]/u.test(family)) continue
    families.set(family, [...(families.get(family) ?? []), theme])
  }
  const paired = new Map<NewTheme, NewTheme | null>()
  for (const [family, members] of families) {
    const [first, second] = members
    const light = members.find((theme) => theme.light && !theme.dark)?.light
    const dark = members.find((theme) => theme.dark && !theme.light)?.dark
    if (members.length !== 2 || !first || !second || !light || !dark) continue
    paired.set(first, { name: family, light, dark })
    paired.set(second, null)
  }
  return distinct.flatMap((theme) => {
    const pair = paired.get(theme)
    return pair === null ? [] : [pair ?? theme]
  })
}

class ReachError extends Error {}
const failure = (cause: unknown, fallback: string) =>
  cause instanceof ReachError ? cause.message : fallback

async function readCapped(response: Response, limit: number) {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text + decoder.decode()
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      throw new ReachError('Open VSX sent more than a theme should need.')
    }
    text += decoder.decode(value, { stream: true })
  }
}

/** Sends no cookies and no referrer, so the registry learns nothing about this server. */
async function getText(url: string, limit: number, signal: AbortSignal) {
  const controller = new AbortController()
  const stop = () => controller.abort()
  if (signal.aborted) stop()
  signal.addEventListener('abort', stop, { once: true })
  const timer = setTimeout(stop, TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    })
    if (!response.ok) throw new ReachError('Open VSX could not provide that.')
    return await readCapped(response, limit)
  } catch (cause) {
    if (controller.signal.aborted && !signal.aborted) {
      throw new ReachError('Open VSX took too long to answer.')
    }
    throw cause
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', stop)
  }
}

const fileUrl = ({ namespace, name, version }: SearchEntry | ThemeExtension, path: string) =>
  [
    `${ORIGIN}/vscode/unpkg`,
    ...[namespace, name, version, ...path.split('/')].map(encodeURIComponent),
  ].join('/')

function iconOf(entry: SearchEntry) {
  const icon = entry.files?.icon
  if (!icon) return null
  try {
    const url = new URL(icon)
    return url.origin === ORIGIN ? url.href : null
  } catch {
    return null
  }
}

async function toExtension(entry: SearchEntry, signal: AbortSignal) {
  const text = await getText(fileUrl(entry, 'extension/package.json'), MANIFEST_BYTES, signal)
  const variants = variantsOf(JSON.parse(text))
  if (!variants.length) return []
  const extension: ThemeExtension = {
    namespace: entry.namespace,
    name: entry.name,
    version: entry.version,
    title: entry.displayName?.trim() || entry.name,
    description: entry.description?.trim() ?? '',
    downloads: entry.downloadCount ?? 0,
    icon: iconOf(entry),
    variants,
  }
  return [extension]
}

/** The search category also holds icon themes and language packs, so each result's manifest decides
 *  whether it has a color theme to offer. A result that can't be read drops out alone. */
export async function searchThemes(query: string, sort: Sort, signal: AbortSignal) {
  const url = new URL(`${ORIGIN}/api/-/search`)
  url.search = new URLSearchParams({
    query,
    category: 'Themes',
    sortBy: sort,
    sortOrder: 'desc',
    size: String(RESULTS),
  }).toString()
  let body: z.infer<typeof SearchBody>
  try {
    body = SearchBody.parse(JSON.parse(await getText(url.href, SEARCH_BYTES, signal)))
  } catch (cause) {
    if (signal.aborted) throw cause
    throw new Error(failure(cause, 'Open VSX search is unavailable right now.'), { cause })
  }
  const entries = body.extensions.flatMap((item) => {
    const entry = SearchEntry.safeParse(item)
    return entry.success && !entry.data.deprecated ? [entry.data] : []
  })
  const settled = await Promise.allSettled(entries.map((entry) => toExtension(entry, signal)))
  return settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
}

type ThemeJson = { name?: unknown; type?: unknown; colors: Record<string, unknown> }

async function readThemeJson(
  extension: ThemeExtension,
  path: string,
  signal: AbortSignal,
  chain: readonly string[] = [],
): Promise<ThemeJson> {
  if (chain.includes(path) || chain.length >= MAX_INCLUDES) {
    throw new Error('This theme includes too many files.')
  }
  const file = records(parseJsonc(await getText(fileUrl(extension, path), MAX_FILE_BYTES, signal)))
  const colors = records(file.colors)
  if (typeof file.include !== 'string') return { name: file.name, type: file.type, colors }
  const included = extensionPath(path, file.include)
  if (!included) throw new Error('This theme includes a file outside its extension.')
  const base = await readThemeJson(extension, included, signal, [...chain, path])
  return {
    name: file.name ?? base.name,
    type: file.type ?? base.type,
    colors: { ...base.colors, ...colors },
  }
}

/** Rebuilds each variant as theme file text, so an installed theme crosses the same boundary as a
 *  pasted one and `parseColor` still decides every value. */
async function loadVariant(extension: ThemeExtension, variant: Variant, signal: AbortSignal) {
  const file = await readThemeJson(extension, variant.path, signal)
  if (!Object.keys(file.colors).length) throw new Error('This theme only colors code.')
  const parsed = parseThemeFile(
    JSON.stringify({
      name: variant.label ?? (typeof file.name === 'string' ? file.name : undefined),
      type: variant.scheme ?? (typeof file.type === 'string' ? file.type : 'unstated'),
      colors: file.colors,
    }),
    variant.path.split('/').at(-1),
  )
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.theme
}

/** One unreadable variant does not cost the rest of the extension. */
export async function loadThemes(
  extension: ThemeExtension,
  signal: AbortSignal,
): Promise<LoadedThemes> {
  const settled = await Promise.allSettled(
    extension.variants.map((variant) => loadVariant(extension, variant, signal)),
  )
  signal.throwIfAborted()
  const themes = settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
  return { themes: pairVariants(themes), unreadable: settled.length - themes.length }
}
