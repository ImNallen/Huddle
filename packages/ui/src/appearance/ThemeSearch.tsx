import { useEffect, useRef, useState } from 'react'
import { Download, LoaderCircle, Palette } from 'lucide-react'
import { Alert } from '../primitives'
import { loadThemes, POPULAR, searchThemes, SORTS, type Sort, type ThemeExtension } from './openVsx'
import { appearance, type Undo } from './store'

const QUIET_MS = 350
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`
const messageOf = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message ? cause.message : fallback

function installMessage(title: string, added: number, unreadable: number, skipped: number) {
  const parts = [
    added ? `Added ${plural(added, 'theme')} from ${title}.` : `${title} is already here.`,
  ]
  if (unreadable) parts.push(`${plural(unreadable, 'theme')} could not be read.`)
  if (skipped) parts.push(`${plural(skipped, 'name')} already held different colors.`)
  return parts.join(' ')
}

function ExtensionIcon({ icon }: { icon: string | null }) {
  const [broken, setBroken] = useState(false)
  return (
    <span className="vsx-icon" aria-hidden="true">
      {icon && !broken ? (
        <img
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          src={icon}
          onError={() => setBroken(true)}
        />
      ) : (
        <Palette size={16} />
      )}
    </span>
  )
}

/** Sends nothing until someone searches, because everything else in Huddle stays on their tailnet. */
export function ThemeSearch({
  onInstalled,
}: {
  onInstalled: (message: string, undo: Undo | null) => void
}) {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort>('relevance')
  const [found, setFound] = useState<readonly ThemeExtension[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [error, setError] = useState('')
  const [installing, setInstalling] = useState<ThemeExtension | null>(null)
  const install = useRef<AbortController | null>(null)
  const term = query.trim()

  useEffect(() => {
    setError('')
    if (!term) {
      setFound(null)
      setSearching(false)
      return
    }
    setSearching(true)
    const controller = new AbortController()
    const { signal } = controller
    const timer = setTimeout(() => {
      searchThemes(term, sort, signal).then(
        (extensions) => {
          if (signal.aborted) return
          setFound(extensions)
          setSearching(false)
        },
        (cause: unknown) => {
          if (signal.aborted) return
          setFound(null)
          setSearching(false)
          setError(messageOf(cause, 'Open VSX search is unavailable right now.'))
        },
      )
    }, QUIET_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [term, sort, attempt])
  useEffect(() => () => install.current?.abort(), [])

  async function installExtension(extension: ThemeExtension) {
    const controller = new AbortController()
    install.current = controller
    setError('')
    setInstalling(extension)
    try {
      const { themes, unreadable } = await loadThemes(extension, controller.signal)
      if (!themes.length) throw new Error(`${extension.title} has no theme Huddle can read.`)
      const result = appearance.install(themes)
      if (!result.ok) throw new Error(result.error)
      onInstalled(
        installMessage(extension.title, result.added, unreadable, result.skipped.length),
        result.added ? result.undo : null,
      )
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(messageOf(cause, `${extension.title} could not be added.`))
      }
    } finally {
      if (!controller.signal.aborted) setInstalling(null)
    }
  }

  const status = searching
    ? 'Searching Open VSX.'
    : found
      ? found.length
        ? plural(found.length, 'extension')
        : `No color themes match ${term}.`
      : ''
  return (
    <section className="vsx" aria-labelledby="vsx-heading">
      <h3 id="vsx-heading" className="sr-only">
        Search community themes
      </h3>
      <form
        className="vsx-search"
        onSubmit={(event) => {
          event.preventDefault()
          if (term) setAttempt((count) => count + 1)
        }}
      >
        <input
          type="text"
          role="searchbox"
          aria-label="Search community themes"
          spellCheck={false}
          autoComplete="off"
          placeholder="Search Open VSX themes"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {searching && <LoaderCircle className="vsx-spin" size={14} aria-hidden="true" />}
        <button type="submit" disabled={!term || searching}>
          Search
        </button>
      </form>
      {term && (
        <div className="vsx-controls">
          <span className="vsx-popular">
            Popular
            {POPULAR.map((name) => (
              <button
                key={name}
                type="button"
                aria-pressed={term === name}
                onClick={() => setQuery(name)}
              >
                {name}
              </button>
            ))}
          </span>
          <label className="vsx-sort">
            Sort
            <select
              value={sort}
              onChange={(event) => {
                const next = SORTS.find((option) => option.value === event.target.value)
                if (next) setSort(next.value)
              }}
            >
              {SORTS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <p className="vsx-status" role="status">
        {status}
      </p>
      <Alert message={error} />
      {error && !found && term && (
        <button
          type="button"
          className="button small vsx-retry"
          onClick={() => setAttempt((count) => count + 1)}
        >
          Try again
        </button>
      )}
      {found && found.length > 0 && (
        <ul className="vsx-results" aria-busy={searching}>
          {found.map((extension) => {
            const key = `${extension.namespace}.${extension.name}`
            return (
              <li key={key} className="vsx-card">
                <div className="vsx-card-head">
                  <ExtensionIcon key={extension.icon} icon={extension.icon} />
                  <span>
                    <strong title={extension.title}>{extension.title}</strong>
                    <small>
                      {extension.namespace} · {compact.format(extension.downloads)} downloads
                    </small>
                  </span>
                </div>
                <p>{extension.description || 'A community color theme.'}</p>
                <div className="vsx-card-footer">
                  <small>{plural(extension.variants.length, 'theme')}</small>
                  <button
                    type="button"
                    className="button small"
                    aria-label={`Install ${extension.title}`}
                    disabled={installing !== null}
                    onClick={() => void installExtension(extension)}
                  >
                    {installing === extension ? (
                      <LoaderCircle className="vsx-spin" size={14} />
                    ) : (
                      <Download size={14} />
                    )}
                    {installing === extension ? 'Installing' : 'Install'}
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
