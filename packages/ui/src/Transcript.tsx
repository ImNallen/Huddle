import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { SendHorizontal } from 'lucide-react'
import type { Avatar as AvatarValue, Me } from '@huddle/contracts'
import { errorText, type Transport } from './transport'
import {
  threadKey,
  type Pending,
  type Thread,
  type ThreadMessage,
  type useServer,
} from './useServer'
import { Avatar } from './Avatar'
import { Mentions, clock } from './Badges'

type Author = { id: string; name: string; avatar?: AvatarValue | null }
type MessageRow = {
  kind: 'message'
  key: string
  continued: boolean
  author: Author
  at: string
  body: string
  pending: Pending | null
}
type Row = { kind: 'day'; key: string; label: string } | MessageRow

const groupWindow = 7 * 60 * 1000
const atEndTolerance = 2
const layoutOf = (view: HTMLElement) => `${view.scrollHeight}x${view.clientHeight}`

function rows(
  messages: ThreadMessage[],
  pending: Pending[],
  me: Author,
  now: string,
  day: (at: string) => string,
): Row[] {
  const entries = [
    ...messages.map((message) => ({
      key: message.id,
      author: { id: message.authorId, name: message.authorName, avatar: message.authorAvatar },
      at: message.createdAt,
      body: message.body,
      pending: null,
    })),
    ...pending.map((message) => ({
      key: message.retryId,
      author: me,
      at: now,
      body: message.body,
      pending: message,
    })),
  ]
  return entries.flatMap((entry, index): Row[] => {
    const previous = entries[index - 1]
    const label = day(entry.at)
    const sameDay = previous !== undefined && day(previous.at) === label
    const continued =
      sameDay &&
      previous.author.id === entry.author.id &&
      Date.parse(entry.at) - Date.parse(previous.at) <= groupWindow
    const message: Row = { kind: 'message', continued, ...entry }
    return sameDay ? [message] : [{ kind: 'day', key: `day:${entry.key}`, label }, message]
  })
}
function day(createdAt: string) {
  const date = new Date(createdAt)
  const today = new Date()
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (date.toDateString() === today.toDateString()) return 'Today'
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
}
function TimeSlot({ row }: { row: MessageRow }) {
  if (row.pending) return <span>{row.pending.kind === 'sending' ? 'Sending…' : 'Not sent'}</span>
  return (
    <time dateTime={row.at} title={new Date(row.at).toLocaleString()}>
      {clock(row.at)}
    </time>
  )
}
export function Transcript({
  client,
  me,
  thread,
  label,
  topbar,
  welcome,
  sync,
  draft,
  onDraft,
}: {
  client: Transport
  me: Me
  thread: Thread
  label: string
  topbar: ReactNode
  welcome: ReactNode
  sync: ReturnType<typeof useServer>
  draft: string
  onDraft: (value: string) => void
}) {
  const [more, setMore] = useState(true)
  const [error, setError] = useState('')
  const scroller = useRef<HTMLDivElement>(null)
  const atEnd = useRef(true)
  const measured = useRef('')
  const key = threadKey(thread)
  const messages = sync.messages.filter((message) => threadKey(message.thread) === key)
  const pending = sync.pending.filter((message) => threadKey(message.thread) === key)
  const photo = client.photo?.bind(client)
  function keepAtEnd() {
    const view = scroller.current
    if (!view) return
    if (atEnd.current) view.scrollTop = view.scrollHeight
    measured.current = layoutOf(view)
  }
  useLayoutEffect(keepAtEnd, [messages.length, pending.length])
  useEffect(() => {
    const view = scroller.current
    if (!view?.firstElementChild) return
    const observer = new ResizeObserver(keepAtEnd)
    observer.observe(view)
    observer.observe(view.firstElementChild)
    return () => observer.disconnect()
  }, [])
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const body = draft.trim()
    if (!body) return
    atEnd.current = true
    void sync.send({ retryId: crypto.randomUUID(), thread, body })
    onDraft('')
  }
  async function older() {
    try {
      setMore((await sync.older()) === 100)
    } catch (failure) {
      setError(errorText(failure))
    }
  }
  return (
    <main className="main">
      {topbar}
      <div
        className="scroll"
        ref={scroller}
        onScroll={({ currentTarget: view }) => {
          // A resize clamps or anchors the scroll position too. Only a scroll in a settled layout is
          // the reader moving, and the resize observer handles the rest.
          if (layoutOf(view) !== measured.current) return
          atEnd.current = view.scrollHeight - view.scrollTop - view.clientHeight <= atEndTolerance
        }}
      >
        <div className="thread">
          <section className="channel-welcome">{welcome}</section>
          {sync.historyState === 'loading' && <p className="thread-note">Loading conversation…</p>}
          {sync.historyState === 'failed' && (
            <p className="form-error thread-note" role="alert">
              {sync.historyError}{' '}
              <button className="link" onClick={sync.retry}>
                Try again
              </button>
            </p>
          )}
          {messages.length >= 100 && more && (
            <button className="button older" onClick={() => void older()}>
              Load earlier messages
            </button>
          )}
          {sync.queueError && (
            <p role="alert" className="form-error thread-note">
              {sync.queueError}
            </p>
          )}
          {error && (
            <p role="alert" className="form-error thread-note">
              {error}
            </p>
          )}
          {rows(messages, pending, me.user, new Date().toISOString(), day).map((row) =>
            row.kind === 'day' ? (
              <div className="day-divider" key={row.key}>
                <span>{row.label}</span>
              </div>
            ) : (
              <article
                key={row.key}
                className={`message ${row.continued ? 'continued' : ''} ${row.pending?.kind ?? ''}`}
              >
                {row.continued ? (
                  <span className="message-gutter">
                    <TimeSlot row={row} />
                  </span>
                ) : (
                  <>
                    <span className="message-avatar">
                      <Avatar
                        avatar={row.author.avatar}
                        name={row.author.name}
                        photo={photo}
                        size={40}
                      />
                    </span>
                    <div className="message-meta">
                      <strong>{row.author.name}</strong>
                      <TimeSlot row={row} />
                    </div>
                  </>
                )}
                <p className="message-body">
                  <Mentions text={row.body} />
                </p>
                {row.pending?.kind === 'failed' && (
                  <p className="form-error">
                    {row.pending.error}{' '}
                    <button
                      className="link"
                      onClick={() => row.pending && void sync.send(row.pending)}
                    >
                      Retry
                    </button>
                  </p>
                )}
              </article>
            ),
          )}
        </div>
      </div>
      <form className="composer" onSubmit={submit}>
        <label className="sr-only" htmlFor="message">
          {label}
        </label>
        <textarea
          id="message"
          rows={1}
          maxLength={8000}
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              event.currentTarget.form?.requestSubmit()
            }
          }}
          placeholder={label}
        />
        <button aria-label="Send message" title="Send message" disabled={!draft.trim()}>
          <SendHorizontal size={20} />
        </button>
      </form>
    </main>
  )
}
