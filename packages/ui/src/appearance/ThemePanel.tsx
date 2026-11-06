import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Paintbrush, X } from 'lucide-react'
import { Overlay } from '../primitives'
import { parseColor, rgbaOf, withAlpha, type ColorLiteral } from './color'
import {
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
import { MAX_THEME_NAME, themeOfHalves } from './themeFile'
import type { Theme } from './builtins'
import { appearance } from './store'

type Side = {
  background: string
  accent: string
  overrides: Partial<Record<TokenName, string>>
}
type Draft = Side & {
  name: string
  scheme: Scheme
  advanced: boolean
  /** Editing only: the side not on screen, kept as typed. */
  other: Side | null
}
type Parsed = { ok: true; half: Half } | { ok: false; field: string; error: string }

const seedSide = (scheme: Scheme): Side => ({ ...SEEDS[scheme], overrides: {} })
const sideOf = (half: Half): Side => ({
  background: half.background,
  accent: half.accent,
  overrides: { ...half.overrides },
})
const sideOfDraft = ({ background, accent, overrides }: Draft): Side => ({
  background,
  accent,
  overrides,
})
const opposite = (scheme: Scheme): Scheme => (scheme === 'dark' ? 'light' : 'dark')
const isUntouched = (side: Side, scheme: Scheme) =>
  side.background === SEEDS[scheme].background &&
  side.accent === SEEDS[scheme].accent &&
  !Object.values(side.overrides).some((value) => value.trim())

function firstDraft(initialScheme: Scheme, editing: Theme | undefined): Draft {
  if (!editing) {
    return {
      name: '',
      scheme: initialScheme,
      ...seedSide(initialScheme),
      advanced: false,
      other: null,
    }
  }
  const scheme = editing[initialScheme] ? initialScheme : opposite(initialScheme)
  const half = editing[scheme]
  const other = editing[opposite(scheme)]
  return {
    name: editing.name,
    scheme,
    ...(half ? sideOf(half) : seedSide(scheme)),
    advanced: false,
    other: other ? sideOf(other) : null,
  }
}

const GROUPS = [
  'Surfaces',
  'Washes and lines',
  'Action',
  'Text',
  'Status',
  'Access screens',
] as const

function parseSide(draft: Side): Parsed {
  const background = parseColor(draft.background)
  if (!background) return { ok: false, field: 'background', error: 'Background is not a color.' }
  const accent = parseColor(draft.accent)
  if (!accent) return { ok: false, field: 'accent', error: 'Accent is not a color.' }
  const overrides: Half['overrides'] = {}
  for (const name of TOKEN_NAMES) {
    const text = draft.overrides[name]?.trim()
    if (!text) continue
    const literal = parseColor(text)
    if (!literal) {
      return { ok: false, field: name, error: `${TOKENS[name].label} is not a color.` }
    }
    overrides[name] = literal
  }
  return { ok: true, half: { background, accent, overrides } }
}

function ColorField({
  label,
  value,
  fallback,
  invalid,
  placeholder,
  onChange,
}: {
  label: string
  value: string
  fallback: ColorLiteral
  invalid: boolean
  placeholder?: string
  onChange: (value: string) => void
}) {
  const shown = parseColor(value) ?? fallback
  return (
    <span className="color-field">
      <input
        type="color"
        aria-label={`${label} picker`}
        value={withAlpha(shown, 1)}
        onChange={(event) => {
          const picked = parseColor(event.target.value)
          if (picked) onChange(withAlpha(picked, rgbaOf(shown).a))
        }}
      />
      <input
        type="text"
        aria-label={label}
        aria-invalid={invalid || undefined}
        spellCheck={false}
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </span>
  )
}

function AdvancedRows({
  draft,
  palette,
  invalidField,
  setOverride,
}: {
  draft: Draft
  palette: Palette
  invalidField: string | null
  setOverride: (name: TokenName, value: string) => void
}) {
  return (
    <>
      {GROUPS.map((group) => (
        <section key={group} className="theme-panel-group">
          <h3>{group}</h3>
          {TOKEN_NAMES.filter((name) => TOKENS[name].group === group).map((name) => {
            const reading = guardReading(palette, name)
            return (
              <div key={name} className="theme-panel-row">
                <span className="theme-panel-token">
                  {TOKENS[name].label}
                  {reading && (
                    <small className={reading.ratio < reading.min ? 'is-low' : undefined}>
                      {reading.ratio.toFixed(1)}:1 on {reading.on}
                    </small>
                  )}
                </span>
                <ColorField
                  label={TOKENS[name].label}
                  value={draft.overrides[name] ?? ''}
                  fallback={palette[name]}
                  invalid={invalidField === name}
                  placeholder={palette[name]}
                  onChange={(value) => setOverride(name, value)}
                />
              </div>
            )
          })}
        </section>
      ))}
    </>
  )
}

export function ThemePanel({
  initialScheme,
  editing,
  onClose,
  onSaved,
}: {
  initialScheme: Scheme
  editing?: Theme
  onClose: () => void
  onSaved: (id: string, scheme: Scheme) => void
}) {
  const [draft, setDraft] = useState<Draft>(() => firstDraft(initialScheme, editing))
  const [error, setError] = useState('')
  const name = useRef<HTMLInputElement>(null)
  const lastValid = useRef<Half | null>(null)
  const parsed = useMemo(() => parseSide(draft), [draft])
  if (parsed.ok) lastValid.current = parsed.half
  const half = lastValid.current
  const palette = useMemo(() => half && resolveHalf(half, draft.scheme), [half, draft.scheme])
  const edited = Object.values(draft.overrides).filter((value) => value.trim()).length

  useEffect(() => {
    name.current?.focus()
    return () => appearance.preview(null)
  }, [])
  useEffect(() => {
    if (half) appearance.preview({ scheme: draft.scheme, half })
  }, [half, draft.scheme])

  const seat = parsed.ok ? seatBackground(parsed.half.background, draft.scheme) : null
  const seated = parsed.ok && seat !== parsed.half.background && !parsed.half.overrides.bg

  function switchScheme(next: Scheme) {
    if (next === draft.scheme) return
    setError('')
    setDraft((current) => {
      if (editing) {
        // A side this theme never had, opened and left as it was, is not worth saving.
        const leaving = sideOfDraft(current)
        const keeps = editing[current.scheme] || !isUntouched(leaving, current.scheme)
        return {
          ...current,
          ...(current.other ?? seedSide(next)),
          scheme: next,
          other: keeps ? leaving : null,
        }
      }
      const literal = parseColor(current.background)
      const movesOnNewSide = literal && seatBackground(literal, next) !== literal
      const isOldDefault = current.background === SEEDS[current.scheme].background
      return {
        ...current,
        scheme: next,
        background: movesOnNewSide || isOldDefault ? SEEDS[next].background : current.background,
        accent:
          current.accent === SEEDS[current.scheme].accent ? SEEDS[next].accent : current.accent,
      }
    })
  }
  function submit(event: FormEvent) {
    event.preventDefault()
    if (!parsed.ok) return setError(parsed.error)
    const other = draft.other && parseSide(draft.other)
    if (other && !other.ok) {
      return setError(`The ${opposite(draft.scheme)} version needs a fix. ${other.error}`)
    }
    const theme = themeOfHalves(draft.name, {
      [draft.scheme]: parsed.half,
      ...(other?.ok ? { [opposite(draft.scheme)]: other.half } : {}),
    })
    if (!theme) return
    const result = editing
      ? appearance.update(editing.id, theme, draft.scheme)
      : appearance.save(theme)
    if (!result.ok) return setError(result.error)
    onSaved(result.id, draft.scheme)
    onClose()
  }
  const invalidField = parsed.ok ? null : parsed.field
  const title = editing ? 'Edit theme' : 'Create theme'
  return (
    <Overlay
      className="theme-panel"
      labelledBy="theme-panel-title"
      onClose={onClose}
      dismissOnBackdrop={false}
    >
      <form onSubmit={submit}>
        <header>
          <h2 id="theme-panel-title">{title}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close panel"
            title="Close panel"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>
        <div className="theme-panel-body">
          <label className="theme-panel-row">
            <span>Theme name</span>
            <input
              ref={name}
              placeholder="e.g. Aurora"
              maxLength={MAX_THEME_NAME}
              value={draft.name}
              onChange={(event) => {
                const next = event.target.value
                setDraft((current) => ({ ...current, name: next }))
                setError('')
              }}
            />
          </label>
          <div className="theme-panel-row">
            <span id="theme-panel-appearance">Appearance</span>
            <span
              className="theme-segmented"
              role="radiogroup"
              aria-labelledby="theme-panel-appearance"
            >
              {(['light', 'dark'] as const).map((scheme) => (
                <label key={scheme}>
                  <input
                    type="radio"
                    name="theme-panel-scheme"
                    checked={draft.scheme === scheme}
                    onChange={() => switchScheme(scheme)}
                  />
                  {scheme === 'light' ? 'Light' : 'Dark'}
                </label>
              ))}
            </span>
          </div>
          <div className="theme-panel-colors">
            <span>
              Colors
              <small>Two colors, the rest derived</small>
            </span>
            <label className="theme-switch">
              Advanced
              <input
                type="checkbox"
                role="switch"
                checked={draft.advanced}
                onChange={(event) => {
                  const advanced = event.target.checked
                  setDraft((current) => ({ ...current, advanced }))
                }}
              />
              <i aria-hidden="true" />
            </label>
          </div>
          <div className="theme-panel-row">
            <span>Background</span>
            <ColorField
              label="Background"
              value={draft.background}
              fallback={SEEDS[draft.scheme].background}
              invalid={invalidField === 'background'}
              onChange={(background) => setDraft((current) => ({ ...current, background }))}
            />
          </div>
          <div className="theme-panel-row">
            <span>Accent</span>
            <ColorField
              label="Accent"
              value={draft.accent}
              fallback={SEEDS[draft.scheme].accent}
              invalid={invalidField === 'accent'}
              onChange={(accent) => setDraft((current) => ({ ...current, accent }))}
            />
          </div>
          {seated && seat && (
            <p className="theme-panel-note">Adjusted to {seat} so text stays readable.</p>
          )}
          {editing && !editing[draft.scheme] && (
            <p className="theme-panel-note">
              This theme has no {draft.scheme} version yet. Saving adds one.
            </p>
          )}
          {!draft.advanced && edited > 0 && (
            <p className="theme-panel-note">
              {edited} {edited === 1 ? 'color' : 'colors'} set individually.{' '}
              <button
                type="button"
                className="link"
                onClick={() => setDraft((current) => ({ ...current, overrides: {} }))}
              >
                Reset
              </button>
            </p>
          )}
          {draft.advanced && palette && (
            <AdvancedRows
              draft={draft}
              palette={palette}
              invalidField={invalidField}
              setOverride={(token, value) =>
                setDraft((current) => ({
                  ...current,
                  overrides: { ...current.overrides, [token]: value },
                }))
              }
            />
          )}
        </div>
        {(error || !parsed.ok) && (
          <p className="form-error theme-panel-error" role="alert">
            {parsed.ok ? error : parsed.error}
          </p>
        )}
        <footer>
          <button type="button" className="button small text" onClick={onClose}>
            Cancel
          </button>
          <button className="button small primary">
            <Paintbrush size={14} />
            {editing ? 'Save theme' : 'Create theme'}
          </button>
        </footer>
      </form>
    </Overlay>
  )
}
