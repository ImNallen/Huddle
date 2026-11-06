import { useSyncExternalStore } from 'react'
import { z } from 'zod'
import { parseColor, type ColorLiteral } from './color'
import {
  isTokenName,
  resolveHalf,
  SCHEMES,
  TOKEN_NAMES,
  type Half,
  type Palette,
  type Scheme,
} from './palette'
import { BUILT_IN_THEMES, HUDDLE_ID, HUDDLE_NAME, type Theme } from './builtins'
import { MAX_THEME_NAME, themeFileText, type NewTheme } from './themeFile'

export type Mode = 'system' | Scheme
export type Selected = Record<Scheme, string>
export type Preview = { scheme: Scheme; half: Half }
export type ListedTheme =
  | { kind: 'huddle'; id: string; name: string }
  | (Theme & { kind: 'built-in' | 'custom' })
export type Appearance = {
  mode: Mode
  scheme: Scheme
  selected: Selected
  themes: readonly ListedTheme[]
}
type State = { mode: Mode; selected: Selected; themes: readonly Theme[] }

export const STORAGE_KEYS = {
  mode: 'huddle.appearance.mode',
  selected: 'huddle.appearance.selected.v1',
  themes: 'huddle.themes.v1',
  paint: 'huddle.appearance.paint.v1',
} as const

const Literal = z.string().transform((text, context): ColorLiteral => {
  const literal = parseColor(text)
  if (!literal) {
    context.addIssue({ code: 'custom', message: 'Not a color.' })
    return z.NEVER
  }
  return literal
})
const Overrides = z.record(z.string(), z.unknown()).transform((raw, context) => {
  const overrides: Half['overrides'] = {}
  for (const [name, value] of Object.entries(raw)) {
    if (!isTokenName(name)) continue
    const literal = Literal.safeParse(value)
    if (literal.success) overrides[name] = literal.data
    else context.addIssue({ code: 'custom', message: `${name} is not a color.` })
  }
  return overrides
})
const StoredHalf = z.object({ background: Literal, accent: Literal, overrides: Overrides })
const StoredTheme = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(MAX_THEME_NAME),
  light: StoredHalf.optional(),
  dark: StoredHalf.optional(),
})
const StoredSelected = z.object({ light: z.string(), dark: z.string() })
const StoredMode = z.enum(['light', 'dark'])

const DEFAULT_SELECTED: Selected = { light: HUDDLE_ID, dark: HUDDLE_ID }

function readKey(key: string) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function writeKey(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}
function readJson(key: string): unknown {
  try {
    return JSON.parse(readKey(key) ?? 'null')
  } catch {
    return null
  }
}
function readThemes(): Theme[] {
  const stored = readJson(STORAGE_KEYS.themes)
  if (!Array.isArray(stored)) return []
  return stored.flatMap((item: unknown): Theme[] => {
    const parsed = StoredTheme.safeParse(item)
    if (!parsed.success) return []
    const { id, name, light, dark } = parsed.data
    if (light) return [{ id, name, light, ...(dark ? { dark } : {}) }]
    return dark ? [{ id, name, dark }] : []
  })
}
function load(): State {
  const mode = StoredMode.safeParse(readKey(STORAGE_KEYS.mode))
  const selected = StoredSelected.safeParse(readJson(STORAGE_KEYS.selected))
  return {
    mode: mode.success ? mode.data : 'system',
    selected: selected.success ? selected.data : DEFAULT_SELECTED,
    themes: readThemes(),
  }
}

const libraryOf = ({ themes }: State): readonly Theme[] => [...BUILT_IN_THEMES, ...themes]

// A selection that names a deleted theme or a missing half reads as Huddle. Deleted, corrupt, and
// half-missing share this path, and no cleanup write exists to forget.
function haveHalf(current: State, scheme: Scheme): Theme | undefined {
  const id = current.selected[scheme]
  return libraryOf(current).find((theme) => theme.id === id && theme[scheme])
}
function effectiveSelected(current: State): Selected {
  return {
    light: haveHalf(current, 'light')?.id ?? HUDDLE_ID,
    dark: haveHalf(current, 'dark')?.id ?? HUDDLE_ID,
  }
}
function paintOf(current: State): Partial<Record<Scheme, Palette>> {
  const paint: Partial<Record<Scheme, Palette>> = {}
  for (const scheme of SCHEMES) {
    const half = haveHalf(current, scheme)?.[scheme]
    if (half) paint[scheme] = resolveHalf(half, scheme)
  }
  return paint
}

const hasMedia = () => typeof matchMedia !== 'undefined'
const systemScheme = (): Scheme =>
  hasMedia() && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
const shownScheme = (current: State): Scheme =>
  current.mode === 'system' ? systemScheme() : current.mode

function listed(current: State): ListedTheme[] {
  return [
    { kind: 'huddle', id: HUDDLE_ID, name: HUDDLE_NAME },
    ...BUILT_IN_THEMES.map((theme) => ({ ...theme, kind: 'built-in' as const })),
    ...current.themes.map((theme) => ({ ...theme, kind: 'custom' as const })),
  ]
}
function snapshotOf(current: State): Appearance {
  return {
    mode: current.mode,
    scheme: shownScheme(current),
    selected: effectiveSelected(current),
    themes: listed(current),
  }
}

let state = load()
let preview: Preview | null = null
let sheet: CSSStyleSheet | null = null
let snapshot = snapshotOf(state)
const listeners = new Set<() => void>()

function notify() {
  snapshot = snapshotOf(state)
  for (const listener of listeners) listener()
}

/** Pure. The boot script builds this same text from the paint cache, and the check compares them. */
export function cssOf(paint: Partial<Record<Scheme, Palette>>) {
  let css = ''
  for (const scheme of SCHEMES) {
    const palette = paint[scheme]
    if (!palette) continue
    const body = TOKEN_NAMES.map((name) => `--${name}:${palette[name]};`).join('')
    css += `:root[data-scheme="${scheme}"]{${body}}`
    css += `@media (prefers-color-scheme:${scheme}){:root:not([data-scheme]){${body}}}`
  }
  return css
}

function render() {
  const paint = paintOf(state)
  if (preview) paint[preview.scheme] = resolveHalf(preview.half, preview.scheme)
  const forced = preview?.scheme ?? (state.mode === 'system' ? undefined : state.mode)
  const root = document.documentElement
  if (forced) root.dataset.scheme = forced
  else delete root.dataset.scheme
  sheet ??= new CSSStyleSheet()
  sheet.replaceSync(cssOf(paint))
  document.adoptedStyleSheets = [sheet]
}

function writePaintCache(current: State) {
  const paint = paintOf(current)
  writeKey(STORAGE_KEYS.paint, Object.keys(paint).length ? JSON.stringify(paint) : null)
}

// Each fact has its own key and only a changed fact is written, so two windows changing different
// facts cannot overwrite each other.
function persist(previous: State, next: State) {
  let stored = true
  const write = (key: string, value: string | null) => {
    stored = writeKey(key, value) && stored
  }
  if (previous.mode !== next.mode) {
    write(STORAGE_KEYS.mode, next.mode === 'system' ? null : next.mode)
  }
  if (previous.selected !== next.selected) {
    write(STORAGE_KEYS.selected, JSON.stringify(next.selected))
  }
  if (previous.themes !== next.themes) write(STORAGE_KEYS.themes, JSON.stringify(next.themes))
  writePaintCache(next)
  return stored
}

function commit(next: State) {
  const stored = persist(state, next)
  state = next
  render()
  notify()
  return stored
}

/** Paints the stored state, refreshes the paint cache, and follows other windows. A new build's
 *  derivation reaches a stored theme here, one paint after an upgrade. */
export function startAppearance(): () => void {
  state = load()
  writePaintCache(state)
  render()
  notify()
  const onStorage = ({ key }: StorageEvent) => {
    if (key !== null && !Object.values<string>(STORAGE_KEYS).includes(key)) return
    state = load()
    render()
    notify()
  }
  const media = matchMedia('(prefers-color-scheme: dark)')
  window.addEventListener('storage', onStorage)
  media.addEventListener('change', notify)
  return () => {
    window.removeEventListener('storage', onStorage)
    media.removeEventListener('change', notify)
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribe, () => snapshot)
}

/** Reads Huddle's values through a hidden element, because CSS is the one place they live.
 *  `getPropertyValue` would return the unresolved `light-dark()` text. */
function huddleHalf(scheme: Scheme): Half {
  const probe = document.createElement('span')
  probe.hidden = true
  probe.dataset.palette = 'huddle'
  probe.style.colorScheme = scheme
  document.body.append(probe)
  try {
    const palette: Half['overrides'] = {}
    for (const name of TOKEN_NAMES) {
      probe.style.color = `var(--${name})`
      const literal = parseColor(getComputedStyle(probe).color)
      if (!literal) throw new Error(`Huddle's ${name} did not resolve.`)
      palette[name] = literal
    }
    const { bg: background, accent, ...overrides } = palette
    if (!background || !accent) throw new Error("Huddle's seeds did not resolve.")
    return { background, accent, overrides }
  } finally {
    probe.remove()
  }
}

const samePaint = (a: Half, b: Half, scheme: Scheme) =>
  JSON.stringify(resolveHalf(a, scheme)) === JSON.stringify(resolveHalf(b, scheme))

function namedTheme(themes: readonly Theme[], name: string) {
  const wanted = name.toLowerCase()
  if (wanted === HUDDLE_NAME.toLowerCase()) {
    return { id: HUDDLE_ID, name: HUDDLE_NAME, half: huddleHalf, custom: false }
  }
  const builtIn = BUILT_IN_THEMES.find((theme) => theme.name.toLowerCase() === wanted)
  if (builtIn) {
    return { ...builtIn, half: (scheme: Scheme) => builtIn[scheme], custom: false }
  }
  const custom = themes.find((theme) => theme.name.toLowerCase() === wanted)
  return custom && { ...custom, half: (scheme: Scheme) => custom[scheme], custom: true }
}

type Placed =
  | { ok: true; id: string; themes: readonly Theme[]; sides: NewTheme; changed: boolean }
  | { ok: false; error: string }

/** A same-named theme takes a missing half, as T3 does, which is how Create builds a two-sided theme.
 *  An identical half is a no-op, and a different half on a taken side is an error. */
function place(themes: readonly Theme[], theme: NewTheme): Placed {
  const name = theme.name.trim().slice(0, MAX_THEME_NAME)
  if (!name) return { ok: false, error: 'Give this theme a name.' }
  const existing = namedTheme(themes, name)
  for (const scheme of SCHEMES) {
    const half = theme[scheme]
    const taken = existing?.half(scheme)
    if (half && taken && !samePaint(half, taken, scheme)) {
      return {
        ok: false,
        error: `${existing?.name} already has a different ${scheme} version. Choose another name.`,
      }
    }
  }
  const id = existing?.id ?? crypto.randomUUID()
  const known = themes.find((item) => item.id === id)
  const merged: Theme = known ? { ...theme, ...known } : { ...theme, id, name }
  const inLibrary = !existing || existing.custom
  const next = !inLibrary
    ? themes
    : known
      ? themes.map((item) => (item.id === id ? merged : item))
      : [...themes, merged]
  const changed = inLibrary && SCHEMES.some((scheme) => theme[scheme] && !known?.[scheme])
  return { ok: true, id, themes: next, sides: inLibrary ? merged : theme, changed }
}

function fileThemeOf(id: string): NewTheme | null {
  if (id === HUDDLE_ID) {
    return { name: HUDDLE_NAME, light: huddleHalf('light'), dark: huddleHalf('dark') }
  }
  return libraryOf(state).find((theme) => theme.id === id) ?? null
}

export type Undo = { available: () => boolean; run: () => void }
/** Good only until the state moves on. Restoring a snapshot after another window saved a theme would
 *  erase that theme, and `onStorage` replaces `state`, so identity catches every later change. */
function undoTo(before: State): Undo {
  const after = state
  const available = () => state === after
  return {
    available,
    run() {
      if (available()) commit(before)
    },
  }
}

export type InstallResult =
  | { ok: true; added: number; skipped: readonly string[]; undo: Undo }
  | { ok: false; error: string }
const OUT_OF_STORAGE = { ok: false, error: 'This device is out of storage.' } as const

export const appearance = {
  setMode(mode: Mode) {
    commit({ ...state, mode })
  },
  /** Never changes the mode. A flip here would silently lose System. */
  select(scheme: Scheme, id: string) {
    commit({ ...state, selected: { ...effectiveSelected(state), [scheme]: id } })
  },
  /** Saving selects the halves, and moves the mode only if the new half would otherwise leave the
   *  screen. */
  save(theme: NewTheme): { ok: true; id: string } | { ok: false; error: string } {
    const placed = place(state.themes, theme)
    if (!placed.ok) return placed
    const shown = shownScheme(state)
    const selected = { ...effectiveSelected(state) }
    for (const scheme of SCHEMES) if (placed.sides[scheme]) selected[scheme] = placed.id
    const mode = theme[shown] ? state.mode : shown === 'dark' ? 'light' : 'dark'
    const stored = commit({ mode, selected, themes: placed.themes })
    return stored ? { ok: true, id: placed.id } : OUT_OF_STORAGE
  },
  /** One write for a whole extension. The first theme with each side takes that side, so an install
   *  shows up at once without the last variant winning. A name already holding different colors is
   *  left alone and reported, because an install has no name field to fix it from. */
  install(themes: readonly NewTheme[]): InstallResult {
    const before = state
    let library = state.themes
    const selected = { ...effectiveSelected(state) }
    const claimed = new Set<Scheme>()
    const skipped: string[] = []
    let added = 0
    for (const theme of themes) {
      const placed = place(library, theme)
      if (!placed.ok) {
        skipped.push(theme.name)
        continue
      }
      library = placed.themes
      if (placed.changed) added += 1
      for (const scheme of SCHEMES) {
        if (!placed.sides[scheme] || claimed.has(scheme)) continue
        selected[scheme] = placed.id
        claimed.add(scheme)
      }
    }
    if (!claimed.size) return { ok: true, added, skipped, undo: undoTo(before) }
    const shown = shownScheme(state)
    const mode = claimed.has(shown) ? state.mode : shown === 'dark' ? 'light' : 'dark'
    const stored = commit({ mode, selected, themes: library })
    return stored ? { ok: true, added, skipped, undo: undoTo(before) } : OUT_OF_STORAGE
  },
  /** Replaces a custom theme in place, so its ID and any selection of it survive a rename. It selects
   *  the side that was just edited, and it never moves the mode: a person tweaking the dark side from
   *  Light has not asked to leave Light. */
  update(
    id: string,
    edit: NewTheme,
    editedSide: Scheme,
  ): { ok: true; id: string } | { ok: false; error: string } {
    const name = edit.name.trim().slice(0, MAX_THEME_NAME)
    if (!name) return { ok: false, error: 'Give this theme a name.' }
    if (!state.themes.some((theme) => theme.id === id)) {
      return { ok: false, error: 'This theme no longer exists.' }
    }
    const taken = namedTheme(state.themes, name)
    if (taken && taken.id !== id) {
      return { ok: false, error: `Another theme is already named ${taken.name}.` }
    }
    const next: Theme = { ...edit, id, name }
    const stored = commit({
      ...state,
      selected: { ...effectiveSelected(state), [editedSide]: id },
      themes: state.themes.map((theme) => (theme.id === id ? next : theme)),
    })
    return stored ? { ok: true, id } : OUT_OF_STORAGE
  },
  remove(id: string) {
    commit({ ...state, themes: state.themes.filter((theme) => theme.id !== id) })
  },
  /** Never reaches `commit`, so a crash mid-preview paints the prior state on the next load. */
  preview(next: Preview | null) {
    preview = next
    render()
  },
  fileText(id: string) {
    const theme = fileThemeOf(id)
    if (!theme) throw new Error('This theme no longer exists.')
    return themeFileText(theme)
  },
}
