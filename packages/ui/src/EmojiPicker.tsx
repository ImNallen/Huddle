import { useRef, useState, type RefObject } from 'react'
import { X } from 'lucide-react'
import { Popover } from './Popover'

import {
  smileys,
  nature,
  food,
  emojiCatalog as catalog,
  type CatalogEmoji,
} from '@huddle/contracts'
import { Emoji } from './Emoji'
const categories = ['Recent', 'Smileys', 'Nature', 'Food'] as const
type Category = (typeof categories)[number]
const recentKey = 'huddle.emoji.recent'
function readRecent(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(recentKey) ?? '[]')
    return Array.isArray(stored)
      ? [
          ...new Set(
            stored.filter(
              (value): value is string =>
                typeof value === 'string' && catalog.some(([symbol]) => symbol === value),
            ),
          ),
        ].slice(0, 32)
      : []
  } catch {
    return []
  }
}

export function EmojiPicker({
  onInsert,
  anchorRef,
  id = 'composer-emoji',
  title = 'Emoji',
  action = 'Insert',
}: {
  onInsert: (emoji: string) => void
  id?: string
  title?: string
  action?: string
  anchorRef?: RefObject<HTMLElement | null>
}) {
  const popover = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<Category>('Smileys')
  const [recent, setRecent] = useState(readRecent)
  const [hovered, setHovered] = useState<CatalogEmoji>(smileys[4])
  const source =
    category === 'Recent'
      ? recent.flatMap((symbol) => catalog.filter(([value]) => value === symbol))
      : category === 'Nature'
        ? nature
        : category === 'Food'
          ? food
          : smileys
  const words = query.trim().toLocaleLowerCase().split(/\s+/)
  const choices = query.trim()
    ? catalog.filter(([symbol, name]) =>
        words.every((word) => `${symbol} ${name.toLocaleLowerCase()}`.includes(word)),
      )
    : source
  const preview = choices.find(([symbol]) => symbol === hovered[0]) ?? choices[0]
  return (
    <Popover
      id={id}
      label={title === 'Emoji' ? 'Emoji picker' : title}
      className="emoji-picker"
      side="top"
      align="start"
      popoverRef={popover}
      anchorRef={anchorRef}
      onOpen={() => {
        setQuery('')
        setRecent(readRecent())
        search.current?.focus()
      }}
    >
      <header className="emoji-header">
        <h2>{title}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Close emoji picker"
          onClick={() => popover.current?.hidePopover()}
        >
          <X size={18} />
        </button>
      </header>
      <input
        ref={search}
        type="search"
        aria-label="Search emoji"
        placeholder="Search emoji"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.preventDefault()
        }}
      />
      <div className="emoji-categories" role="group" aria-label="Emoji categories">
        {categories.map((name) => (
          <button
            type="button"
            key={name}
            aria-pressed={category === name}
            onClick={() => {
              setCategory(name)
              setQuery('')
            }}
          >
            {name}
          </button>
        ))}
      </div>
      <p className="emoji-section">
        {query.trim() ? 'Search results' : category === 'Smileys' ? 'Smileys & people' : category}
      </p>
      <div
        className="emoji-choices"
        onKeyDown={(event) => {
          if (
            !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)
          )
            return
          const buttons = [...event.currentTarget.querySelectorAll('button')]
          const index = buttons.findIndex((button) => button === document.activeElement)
          const delta =
            event.key === 'ArrowUp'
              ? -8
              : event.key === 'ArrowDown'
                ? 8
                : event.key === 'ArrowLeft'
                  ? -1
                  : 1
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? buttons.length - 1
                : Math.max(0, Math.min(index + delta, buttons.length - 1))
          event.preventDefault()
          buttons[next]?.focus()
        }}
      >
        {choices.map((emoji) => (
          <button
            key={emoji[0]}
            type="button"
            aria-label={`${action} ${emoji[0]}`}
            aria-description={emoji[1]}
            onPointerEnter={() => setHovered(emoji)}
            onFocus={() => setHovered(emoji)}
            onClick={() => {
              const next = [
                emoji[0],
                ...readRecent().filter((symbol) => symbol !== emoji[0]),
              ].slice(0, 32)
              try {
                localStorage.setItem(recentKey, JSON.stringify(next))
              } catch {
                /* Selection still works without storage. */
              }
              popover.current?.hidePopover()
              onInsert(emoji[0])
            }}
          >
            <Emoji symbol={emoji[0]} />
          </button>
        ))}
        {!choices.length && (
          <div className="emoji-empty" role="status">
            <strong>{query.trim() ? 'No emoji found' : 'No recent emoji yet'}</strong>
            <p>
              {query.trim()
                ? 'Try another word, or browse a category.'
                : 'Emoji you use will appear here.'}
            </p>
            {query.trim() && (
              <button
                type="button"
                onClick={() => {
                  setQuery('')
                  search.current?.focus()
                }}
              >
                Clear search
              </button>
            )}
          </div>
        )}
      </div>
      <div className="emoji-name" aria-hidden="true">
        <span>{preview ? <Emoji symbol={preview[0]} /> : null}</span>
        {preview ? preview[1] : 'The draft stays in the composer.'}
      </div>
    </Popover>
  )
}
