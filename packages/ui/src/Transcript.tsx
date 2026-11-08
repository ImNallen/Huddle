import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowUp, Plus, Smile } from 'lucide-react'
import type { Avatar as AvatarValue, Me } from '@huddle/contracts'
import { errorText, type Transport } from './transport'
import { RequestError } from './connection'
import {
  threadKey,
  type Pending,
  type Thread,
  type ThreadMessage,
  type useServer,
} from './useServer'
import { Avatar } from './Avatar'
import { Mentions, clock } from './Badges'
import { EmojiPicker } from './EmojiPicker'

type Author = { id: string; name: string; avatar?: AvatarValue | null }
type MessageRow = {
  kind: 'message'
  key: string
  continued: boolean
  author: Author
  at: string
  body: string
  pending: Pending | null
  message: ThreadMessage | null
}
type Row = { kind: 'day'; key: string; label: string } | MessageRow

type Editor =
  | { kind: 'closed' }
  | ({
      message: ThreadMessage
      threadKey: string
      text: string
      retryId: string
    } & { kind: 'editing' | 'saving' | 'failed' | 'conflict' })

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
      message,
    })),
    ...pending.map((message) => ({
      key: message.retryId,
      author: me,
      at: now,
      body: message.body,
      pending: message,
      message: null,
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
  if (date.toDateString() === today.toDateString())
    return `Today, ${date.toLocaleDateString([], { month: 'long', day: 'numeric' })}`
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
  placeholder = label,
  topbar,
  welcome,
  emptyWelcome,
  sync,
  draft,
  onDraft,
}: {
  client: Transport
  me: Me
  thread: Thread
  label: string
  placeholder?: string
  topbar: ReactNode
  welcome: ReactNode
  emptyWelcome?: ReactNode
  sync: ReturnType<typeof useServer>
  draft: string
  onDraft: (value: string) => void
}) {
  const [editor, setEditor] = useState<Editor>({ kind: 'closed' })
  const invoker = useRef<HTMLButtonElement | null>(null)
  const [more, setMore] = useState(true)
  const [error, setError] = useState('')
  const scroller = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const composer = useRef<HTMLFormElement>(null)
  const atEnd = useRef(true)
  const measured = useRef('')
  const key = threadKey(thread)
  useEffect(() => setEditor({ kind: 'closed' }), [key, me.user.id, client])
  function closeEditor() {
    setEditor({ kind: 'closed' })
    requestAnimationFrame(() => invoker.current?.isConnected && invoker.current.focus())
  }
  async function saveEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (
      editor.kind === 'closed' ||
      editor.kind === 'saving' ||
      editor.kind === 'conflict' ||
      !editor.text.trim()
    )
      return
    const saving: Editor = { ...editor, kind: 'saving' }
    setEditor(saving)
    try {
      await sync.edit(saving.message, saving.text.trim(), saving.retryId, saving.message.revision)
      setEditor((current) => {
        if (current !== saving) return current
        requestAnimationFrame(() => invoker.current?.isConnected && invoker.current.focus())
        return { kind: 'closed' }
      })
    } catch (failure) {
      setEditor((current) =>
        current === saving
          ? {
              ...saving,
              kind:
                failure instanceof RequestError && failure.status === 409 ? 'conflict' : 'failed',
            }
          : current,
      )
    }
  }
  const messages = sync.messages.filter((message) => threadKey(message.thread) === key)
  const pending = sync.pending.filter((message) => threadKey(message.thread) === key)
  const isEmpty = sync.historyState === 'ready' && !messages.length && !pending.length
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
  function insert(text: string) {
    const field = input.current
    const start = field?.selectionStart ?? draft.length
    const end = field?.selectionEnd ?? start
    const next = `${draft.slice(0, start)}${text}${draft.slice(end)}`
    if (next.length > 8000) return
    onDraft(next)
    requestAnimationFrame(() => {
      field?.focus()
      field?.setSelectionRange(start + text.length, start + text.length)
    })
  }
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
          <section className="channel-welcome">
            {isEmpty && emptyWelcome ? emptyWelcome : welcome}
          </section>
          {sync.connection === 'Offline · reconnecting' && (
            <div className="thread-state" role="status">
              <strong>Reconnecting…</strong>
              <p>
                The conversation stays here while Huddle reconnects. Your draft stays in the
                composer.
              </p>
            </div>
          )}
          {sync.historyState === 'loading' && (
            <p className="thread-state" role="status">
              Loading conversation…
            </p>
          )}
          {sync.historyState === 'failed' && (
            <div className="thread-state" role="alert">
              <strong>Couldn’t load messages</strong>
              <p>Your conversation is still here. Try loading the messages again.</p>
              <p>{sync.historyError}</p>
              <button className="button small" onClick={sync.retry}>
                Try again
              </button>
            </div>
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
                        size={36}
                      />
                    </span>
                    <div className="message-meta">
                      <strong>{row.author.name}</strong>
                      <TimeSlot row={row} />
                    </div>
                  </>
                )}
                {editor.kind !== 'closed' &&
                editor.threadKey === key &&
                editor.message.id === row.key ? (
                  <form
                    className="message-editor"
                    onSubmit={(event) => void saveEdit(event)}
                    aria-label="Edit message"
                    aria-busy={editor.kind === 'saving'}
                    data-state={editor.kind}
                    data-empty={!editor.text.trim()}
                  >
                    <label className="sr-only" htmlFor="edit-message">
                      Edit message
                    </label>
                    <textarea
                      id="edit-message"
                      autoFocus
                      rows={3}
                      maxLength={8000}
                      placeholder="Edit your message"
                      aria-describedby={
                        editor.kind === 'failed' || editor.kind === 'conflict'
                          ? 'edit-message-feedback edit-message-help'
                          : 'edit-message-help'
                      }
                      value={editor.text}
                      readOnly={editor.kind === 'saving'}
                      onChange={(event) => {
                        const text = event.target.value
                        setEditor({
                          ...editor,
                          kind: editor.kind === 'conflict' ? 'conflict' : 'editing',
                          text,
                          retryId:
                            text.trim() === editor.text.trim()
                              ? editor.retryId
                              : crypto.randomUUID(),
                        })
                      }}
                      onKeyDown={(event) => {
                        if (event.nativeEvent.isComposing) return
                        if (event.key === 'Escape') {
                          event.preventDefault()
                          closeEditor()
                        }
                        if (event.key === 'Enter' && !event.shiftKey) {
                          event.preventDefault()
                          event.currentTarget.form?.requestSubmit()
                        }
                      }}
                    />
                    {(editor.kind === 'failed' || editor.kind === 'conflict') && (
                      <p id="edit-message-feedback" role="alert" className="form-error">
                        {editor.kind === 'conflict'
                          ? 'This message changed elsewhere. Cancel, then edit the latest version.'
                          : 'Couldn’t save your changes. Your edit is still here.'}
                      </p>
                    )}
                    <div className="message-edit-actions">
                      <span id="edit-message-help">
                        {editor.kind === 'saving'
                          ? 'Saving your changes…'
                          : !editor.text.trim()
                            ? 'Enter a message to save.'
                            : 'Enter to save · Shift+Enter for a new line'}
                      </span>
                      <button type="button" className="button small" onClick={closeEditor}>
                        Cancel
                      </button>
                      <button
                        className="button small primary"
                        disabled={
                          editor.kind === 'saving' ||
                          editor.kind === 'conflict' ||
                          !editor.text.trim()
                        }
                      >
                        {editor.kind === 'saving' ? 'Saving…' : 'Save'}
                      </button>
                    </div>
                  </form>
                ) : (
                  <>
                    <p className="message-body">
                      <Mentions text={row.body} />
                      {row.message?.editedAt && (
                        <time
                          className="message-edited"
                          dateTime={row.message.editedAt}
                          title={`Edited ${new Date(row.message.editedAt).toLocaleString()}`}
                        >
                          {' '}
                          (edited)
                        </time>
                      )}
                    </p>
                  </>
                )}
                {row.message && row.author.id === me.user.id && (
                  <button
                    type="button"
                    className="message-edit button small"
                    hidden={editor.kind !== 'closed' && editor.message.id === row.key}
                    aria-label="Edit message"
                    onClick={(event) => {
                      if (!row.message) return
                      invoker.current = event.currentTarget
                      setEditor({
                        kind: 'editing',
                        message: row.message,
                        threadKey: key,
                        text: row.body,
                        retryId: crypto.randomUUID(),
                      })
                    }}
                  >
                    Edit
                  </button>
                )}
                {row.pending?.kind === 'failed' && (
                  <div className="message-retry" role="alert">
                    <span>
                      Couldn’t send this message.
                      <span className="message-retry-detail">{row.pending.error}</span>
                    </span>
                    <button
                      className="button small"
                      onClick={() => row.pending && void sync.send(row.pending)}
                    >
                      Retry
                    </button>
                  </div>
                )}
              </article>
            ),
          )}
        </div>
      </div>
      <form ref={composer} className="composer" onSubmit={submit}>
        <label className="sr-only" htmlFor="message">
          {label}
        </label>
        <textarea
          ref={input}
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
          placeholder={placeholder}
        />
        <div className="composer-actions">
          <button
            type="button"
            className="composer-tool"
            aria-label="Add mention"
            data-tooltip="Add mention"
            onClick={() => insert('@')}
          >
            <Plus size={18} />
          </button>
          <button
            type="button"
            className="composer-tool"
            aria-label="Add emoji"
            data-tooltip="Add emoji"
            popoverTarget="composer-emoji"
          >
            <Smile size={18} />
          </button>
          <EmojiPicker onInsert={insert} anchorRef={composer} />
          <button
            className="composer-send"
            aria-label="Send message"
            data-tooltip="Send message"
            disabled={!draft.trim()}
          >
            <ArrowUp size={18} />
          </button>
        </div>
      </form>
    </main>
  )
}
