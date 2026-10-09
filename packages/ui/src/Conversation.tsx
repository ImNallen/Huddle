import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowUp, Hash, Plus } from 'lucide-react'
import type { Channel, Room, Session, Server } from '@huddle/contracts'
import { errorText, type Transport } from './transport'
import type { useServer } from './useServer'
import type { Dialog } from './ServerView'
import { Avatar } from './Avatar'
import { Badge, Mentions, clock } from './Badges'

function Own({
  body,
  meta,
  state = '',
  children,
}: {
  body: string
  meta: ReactNode
  state?: string
  children?: ReactNode
}) {
  return (
    <article className={`own ${state}`}>
      <div className="bubble">
        <p>
          <Mentions text={body} />
        </p>
        <span className="bubble-meta">{meta}</span>
      </div>
      {children}
    </article>
  )
}
function Time({ at }: { at: string }) {
  return (
    <time dateTime={at} title={new Date(at).toLocaleString()}>
      {clock(at)}
    </time>
  )
}
function day(createdAt: string) {
  const date = new Date(createdAt)
  const today = new Date()
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (date.toDateString() === today.toDateString()) return 'Today'
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
}
export function Conversation({
  client,
  session,
  server,
  room,
  channel,
  sync,
  draft,
  onDraft,
  onDialog,
}: {
  client: Transport
  session: Session
  server: Server
  room: Room
  channel: Channel | undefined
  sync: ReturnType<typeof useServer>
  draft: string
  onDraft: (value: string) => void
  onDialog: (dialog: Dialog) => void
}) {
  const [more, setMore] = useState(true)
  const [error, setError] = useState('')
  const bottom = useRef<HTMLDivElement>(null)
  const messages = sync.messages.filter((message) => message.channelId === channel?.id)
  const pending = sync.pending.filter((message) => message.channelId === channel?.id)
  const photo = client.photo?.bind(client)
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, pending.length, channel?.id])
  useEffect(() => setMore(true), [channel?.id])
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const body = draft.trim()
    if (!channel || !body) return
    void sync.send({ retryId: crypto.randomUUID(), channelId: channel.id, body })
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
      <header className="topbar">
        <Badge id={room.id} name={room.name} />
        <span className="crumb">{room.name}</span>
        {channel && (
          <>
            <span className="crumb-separator">/</span>
            <strong># {channel.name}</strong>
          </>
        )}
      </header>
      {!channel ? (
        <div className="center-state">
          <span className="empty-mark">
            <Hash size={22} />
          </span>
          <h2>{room.name} has no channels yet</h2>
          <p>
            {server.role === 'admin'
              ? 'Channels hold the conversation inside a room. Start with one.'
              : 'An admin can create the first channel.'}
          </p>
          {server.role === 'admin' && (
            <button
              className="button primary"
              onClick={() => onDialog({ kind: 'channel', roomId: room.id })}
            >
              <Plus size={15} />
              Create a channel
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="scroll">
            <div className="thread">
              <section className="channel-welcome">
                <span className="empty-mark">
                  <Hash size={20} />
                </span>
                <h1>Welcome to #{channel.name}</h1>
                <p>
                  This is the start of #{channel.name} in {room.name}.
                </p>
              </section>
              {sync.historyState === 'loading' && (
                <p className="thread-note">Loading conversation…</p>
              )}
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
              {messages.map((message, index) => {
                const label = day(message.createdAt)
                const divider =
                  index === 0 || day(messages[index - 1]?.createdAt ?? '') !== label ? (
                    <div className="day-divider">
                      <span>{label}</span>
                    </div>
                  ) : null
                return (
                  <div key={message.id}>
                    {divider}
                    {message.authorId === session.user.id ? (
                      <Own body={message.body} meta={<Time at={message.createdAt} />} />
                    ) : (
                      <article className="message">
                        <Avatar
                          avatar={message.authorAvatar}
                          name={message.authorName}
                          photo={photo}
                          size={32}
                        />
                        <div>
                          <div className="message-meta">
                            <strong>{message.authorName}</strong>
                            <Time at={message.createdAt} />
                          </div>
                          <p>
                            <Mentions text={message.body} />
                          </p>
                        </div>
                      </article>
                    )}
                  </div>
                )
              })}
              {pending.map((message) => (
                <Own
                  key={message.retryId}
                  body={message.body}
                  meta={message.kind === 'sending' ? 'Sending…' : 'Not sent'}
                  state={message.kind}
                >
                  {message.kind === 'failed' && (
                    <p className="form-error">
                      {message.error}{' '}
                      <button className="link" onClick={() => void sync.send(message)}>
                        Retry
                      </button>
                    </p>
                  )}
                </Own>
              ))}
              <div ref={bottom} />
            </div>
          </div>
          <form className="composer" onSubmit={submit}>
            <label className="sr-only" htmlFor="message">
              Message #{channel.name}
            </label>
            <textarea
              id="message"
              rows={2}
              maxLength={8000}
              value={draft}
              onChange={(event) => onDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  event.currentTarget.form?.requestSubmit()
                }
              }}
              placeholder={`Message #${channel.name}`}
            />
            <div className="composer-bar">
              <span>Enter to send</span>
              <button aria-label="Send message" title="Send message" disabled={!draft.trim()}>
                <ArrowUp size={16} />
              </button>
            </div>
          </form>
        </>
      )}
    </main>
  )
}
