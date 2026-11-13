import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { X } from 'lucide-react'
import { z } from 'zod'
import { GifRef, type GifSettings } from '@huddle/contracts'
import { Popover } from '../Popover'
import { gifName } from './GifMessage'
import { isGridKey, masonry, neighbor, type Placement } from './grid'
import { createKlipy, type GifCategory, type GifFeed, type GifResult } from './klipy'

const recentKey = 'huddle.gif.recent'
const RECENT = 24
const QUIET_MS = 300
const NEAR_END = 320
const SKELETONS = masonry([150, 120, 110, 160, 170, 140].map((height) => ({ width: 193, height })))

type Picked = Extract<GifResult, { kind: 'gif' }>
type Chip = { kind: 'trending' } | { kind: 'recent' } | { kind: 'category'; category: GifCategory }
type View = Chip | { kind: 'search'; query: string }
type Grid =
  | { kind: 'loading' }
  | {
      kind: 'ready'
      results: GifResult[]
      next: number | null
      more: 'idle' | 'loading' | 'failed'
    }
  | { kind: 'empty' }
  | { kind: 'unreachable' }

const Remembered = z.object({ ref: GifRef, thumb: GifRef.shape.animated })
function readRecent(): Picked[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(recentKey) ?? '[]')
    if (!Array.isArray(stored)) return []
    const seen = new Set<string>()
    return stored
      .flatMap((entry): Picked[] => {
        const parsed = Remembered.safeParse(entry)
        if (!parsed.success || seen.has(parsed.data.ref.slug)) return []
        seen.add(parsed.data.ref.slug)
        return [{ kind: 'gif', ...parsed.data, placeholder: null }]
      })
      .slice(0, RECENT)
  } catch {
    return []
  }
}
function remember({ ref, thumb }: Picked) {
  const recent = readRecent().filter((entry) => entry.ref.slug !== ref.slug)
  const next = [{ ref, thumb }, ...recent.map((entry) => ({ ref: entry.ref, thumb: entry.thumb }))]
  try {
    localStorage.setItem(recentKey, JSON.stringify(next.slice(0, RECENT)))
  } catch {}
}

const chipName = (chip: Chip) =>
  chip.kind === 'category' ? chip.category.name : chip.kind === 'recent' ? 'Recent' : 'Trending'
const viewKey = (view: View) =>
  view.kind === 'search'
    ? `search:${view.query}`
    : view.kind === 'category'
      ? `category:${view.category.query}`
      : view.kind
const feedOf = (view: Exclude<View, { kind: 'recent' }>): GifFeed =>
  view.kind === 'trending'
    ? view
    : { kind: 'search', query: view.kind === 'search' ? view.query : view.category.query }
const sectionOf = (view: View) =>
  view.kind === 'search' ? `GIFs for “${view.query}”` : chipName(view)
function emptyOf(view: View): [string, string] {
  if (view.kind === 'search')
    return [`No GIFs for “${view.query}”`, 'Try a different word, or browse a category.']
  if (view.kind === 'recent') return ['No recent GIFs yet', 'GIFs you send will appear here.']
  return [`No GIFs in ${chipName(view)} right now`, 'Try a search, or browse another category.']
}
const sizeOf = (result: GifResult) => (result.kind === 'gif' ? result.ref : result)
const place = ({ column, top, height }: Placement): CSSProperties => ({
  top,
  height,
  left: column ? 'calc(50% + 4px)' : 0,
})

export function GifPicker({
  settings,
  anchorRef,
  returnFocus,
  onPick,
}: {
  settings: GifSettings
  anchorRef: RefObject<HTMLElement | null>
  returnFocus: RefObject<HTMLElement | null>
  onPick: (gif: GifRef) => void
}) {
  const { appKey, contentFilter } = settings
  const klipy = useMemo(() => createKlipy({ appKey, contentFilter }), [appKey, contentFilter])
  const popover = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const loads = useRef<AbortController | null>(null)
  const fetchingMore = useRef(false)
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [query, setQuery] = useState('')
  const [chip, setChip] = useState<Chip>({ kind: 'trending' })
  const [categories, setCategories] = useState<GifCategory[]>([])
  const [grid, setGrid] = useState<Grid>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [active, setActive] = useState(-1)
  const view: View = query ? { kind: 'search', query } : chip
  const key = viewKey(view)

  useEffect(() => {
    const words = text.trim()
    if (!words) {
      setQuery('')
      return
    }
    const timer = setTimeout(() => setQuery(words), QUIET_MS)
    return () => clearTimeout(timer)
  }, [text])

  useEffect(() => {
    if (!open || categories.length) return
    const controller = new AbortController()
    klipy.categories(controller.signal).then(
      (found) => {
        if (!controller.signal.aborted) setCategories(found)
      },
      () => {},
    )
    return () => controller.abort()
  }, [open, klipy, attempt, categories.length])

  useEffect(() => {
    if (!open) return
    setActive(-1)
    scroller.current?.scrollTo({ top: 0 })
    if (view.kind === 'recent') {
      const recent = readRecent()
      setGrid(
        recent.length
          ? { kind: 'ready', results: recent, next: null, more: 'idle' }
          : { kind: 'empty' },
      )
      return
    }
    const controller = new AbortController()
    loads.current = controller
    fetchingMore.current = false
    setGrid({ kind: 'loading' })
    klipy.browse(feedOf(view), 1, controller.signal).then(
      (page) => {
        if (controller.signal.aborted) return
        setGrid(
          page.results.length
            ? { kind: 'ready', results: page.results, next: page.next, more: 'idle' }
            : { kind: 'empty' },
        )
      },
      () => {
        if (!controller.signal.aborted) setGrid({ kind: 'unreachable' })
      },
    )
    return () => controller.abort()
  }, [open, key, attempt, klipy])

  useEffect(() => {
    const panel = popover.current
    if (!panel) return
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      dismiss()
    }
    panel.addEventListener('keydown', onKey)
    return () => panel.removeEventListener('keydown', onKey)
  }, [])

  function dismiss() {
    if (popover.current?.matches(':popover-open')) popover.current.hidePopover()
    returnFocus.current?.focus()
  }
  function pick(result: Picked) {
    remember(result)
    dismiss()
    onPick(result.ref)
  }
  function choose(next: Chip) {
    setText('')
    setQuery('')
    setChip(next)
  }
  function more() {
    const controller = loads.current
    if (
      grid.kind !== 'ready' ||
      grid.next === null ||
      view.kind === 'recent' ||
      !controller ||
      fetchingMore.current
    )
      return
    fetchingMore.current = true
    setGrid({ ...grid, more: 'loading' })
    klipy.browse(feedOf(view), grid.next, controller.signal).then(
      (page) => {
        if (controller.signal.aborted) return
        fetchingMore.current = false
        setGrid((current) =>
          current.kind === 'ready'
            ? {
                kind: 'ready',
                results: [...current.results, ...page.results],
                next: page.next,
                more: 'idle',
              }
            : current,
        )
      },
      () => {
        if (controller.signal.aborted) return
        fetchingMore.current = false
        setGrid((current) => (current.kind === 'ready' ? { ...current, more: 'failed' } : current))
      },
    )
  }

  const results = grid.kind === 'ready' ? grid.results : []
  const layout = useMemo(() => masonry(results.map(sizeOf)), [results])
  const usable = results.map((result) => result.kind === 'gif')
  const entry = usable.indexOf(true)
  const focusTile = (index: number) => {
    const tile = scroller.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)
    tile?.focus()
    tile?.scrollIntoView({ block: 'nearest' })
  }
  const shown = results[active]
  const chips: Chip[] = [
    { kind: 'trending' },
    { kind: 'recent' },
    ...categories.map((category) => ({ kind: 'category' as const, category })),
  ]
  const chipButton = (item: Chip, pressed: boolean, refocus = false) => (
    <button
      type="button"
      key={viewKey(item)}
      aria-pressed={pressed}
      onClick={() => {
        choose(item)
        if (refocus) search.current?.focus()
      }}
    >
      {chipName(item)}
    </button>
  )
  const [emptyTitle, emptyHint] = emptyOf(view)

  return (
    <Popover
      id="composer-gif"
      label="GIF picker"
      className="emoji-picker gif-picker"
      side="top"
      align="start"
      popoverRef={popover}
      anchorRef={anchorRef}
      onOpen={() => {
        setText('')
        setQuery('')
        setChip({ kind: 'trending' })
        setGrid({ kind: 'loading' })
        setOpen(true)
        search.current?.focus()
      }}
      onClose={() => setOpen(false)}
    >
      <header className="emoji-header">
        <h2>GIFs</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Close GIF picker"
          onClick={dismiss}
        >
          <X size={18} />
        </button>
      </header>
      <input
        ref={search}
        type="search"
        aria-label="Search KLIPY"
        placeholder="Search KLIPY"
        maxLength={100}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            setQuery(text.trim())
          } else if (event.key === 'ArrowDown' && entry >= 0) {
            event.preventDefault()
            focusTile(entry)
          }
        }}
      />
      {view.kind !== 'search' && (
        <div
          className="emoji-categories gif-chips"
          role="group"
          aria-label="GIF categories"
          onWheel={(event) => {
            if (!event.deltaX) event.currentTarget.scrollLeft += event.deltaY
          }}
        >
          {chips.map((item) => chipButton(item, viewKey(item) === viewKey(chip)))}
        </div>
      )}
      <p className="emoji-section">{sectionOf(view)}</p>
      <div
        ref={scroller}
        className="gif-grid"
        aria-busy={grid.kind === 'loading'}
        onScroll={({ currentTarget: box }) => {
          if (box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_END) more()
        }}
        onKeyDown={(event) => {
          if (!isGridKey(event.key) || !(event.target instanceof HTMLElement)) return
          const from = Number(event.target.dataset.index)
          if (!Number.isInteger(from)) return
          event.preventDefault()
          const to = neighbor(layout.placements, usable, from, event.key)
          if (to !== null) focusTile(to)
          else if (event.key === 'ArrowUp') search.current?.focus()
        }}
      >
        {grid.kind === 'loading' && (
          <>
            <p className="sr-only" role="status">
              Loading GIFs
            </p>
            <div className="gif-masonry" style={{ height: SKELETONS.height }} aria-hidden="true">
              {SKELETONS.placements.map((placement, index) => (
                <div key={index} className="gif-tile gif-skeleton" style={place(placement)} />
              ))}
            </div>
          </>
        )}
        {grid.kind === 'empty' && (
          <div className="gif-state" role="status">
            <strong>{emptyTitle}</strong>
            <p>{emptyHint}</p>
            {view.kind === 'search' && (
              <div className="emoji-categories gif-chips">
                {chips
                  .filter((item) => item.kind !== 'recent')
                  .slice(0, 4)
                  .map((item) => chipButton(item, viewKey(item) === viewKey(chip), true))}
              </div>
            )}
          </div>
        )}
        {grid.kind === 'unreachable' && (
          <div className="gif-state" role="alert">
            <strong>Couldn’t load GIFs</strong>
            <p>
              Your draft is unchanged.
              <button
                type="button"
                className="gif-retry"
                onClick={() => {
                  setAttempt((count) => count + 1)
                  search.current?.focus()
                }}
              >
                Try again
              </button>
            </p>
          </div>
        )}
        {grid.kind === 'ready' && (
          <>
            <div className="gif-masonry" style={{ height: layout.height }}>
              {results.map((result, index) => {
                const placement = layout.placements[index]
                if (!placement) return null
                if (result.kind === 'unavailable')
                  return (
                    <div
                      key={index}
                      className="gif-tile gif-tile-unavailable"
                      role="img"
                      aria-label={`${gifName(result)} unavailable`}
                      style={place(placement)}
                    >
                      <span aria-hidden="true">GIF unavailable</span>
                    </div>
                  )
                return (
                  <button
                    key={index}
                    type="button"
                    className="gif-tile"
                    data-index={index}
                    tabIndex={index === (usable[active] ? active : entry) ? 0 : -1}
                    aria-label={gifName(result.ref)}
                    style={{
                      ...place(placement),
                      backgroundImage: result.placeholder
                        ? `url("${result.placeholder}")`
                        : undefined,
                    }}
                    onPointerEnter={() => setActive(index)}
                    onFocus={() => setActive(index)}
                    onClick={() => pick(result)}
                  >
                    <picture>
                      <source media="(prefers-reduced-motion: reduce)" srcSet={result.ref.still} />
                      <img
                        src={result.thumb}
                        alt=""
                        referrerPolicy="no-referrer"
                        decoding="async"
                        loading="lazy"
                      />
                    </picture>
                  </button>
                )
              })}
            </div>
            {grid.more === 'loading' && (
              <p className="gif-more" role="status">
                Loading more GIFs…
              </p>
            )}
            {grid.more === 'failed' && (
              <p className="gif-more" role="alert">
                Couldn’t load more GIFs.
                <button type="button" className="gif-retry" onClick={more}>
                  Try again
                </button>
              </p>
            )}
          </>
        )}
      </div>
      <div className="gif-footer">
        <span aria-hidden="true">{shown?.kind === 'gif' ? shown.ref.title : ''}</span>
        <span>Powered by KLIPY</span>
      </div>
    </Popover>
  )
}
