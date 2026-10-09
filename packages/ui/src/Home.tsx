import { useState, type ReactNode } from 'react'
import { Check, CircleCheck, UserPlus } from 'lucide-react'
import type { Channel, ChannelId, HomeItem, Room, Session, Server } from '@huddle/contracts'
import { errorText, type Transport } from './transport'
import type { Dialog, HomeState, View } from './ServerView'
import { Avatar } from './Avatar'
import { Badge, Mentions, clock } from './Badges'

const categories = { mentions: 'Mentions', messages: 'Messages' } as const
type Category = keyof typeof categories
type Kind = HomeItem['kind']
type ItemOf<K extends Kind> = Extract<HomeItem, { kind: K }>
type Place = { channel: Channel; room: Room }
type Row = {
  key: string
  place: Place
  badge: ReactNode
  title: string
  meta: string
  body: ReactNode
  tag: { label: string; accent: boolean }
}
type Entry<K extends Kind> = {
  category: Category
  channel: (item: ItemOf<K>) => ChannelId
  row: (item: ItemOf<K>, place: Place, client: Transport) => Row
}
type Registry = { [K in Kind]: Entry<K> }
const feed = {
  mention: {
    category: 'mentions',
    channel: (item) => item.message.channelId,
    row: ({ message }, place, client) => ({
      key: `mention:${message.id}`,
      place,
      badge: (
        <Avatar
          avatar={message.authorAvatar}
          name={message.authorName}
          photo={client.photo?.bind(client)}
          size={30}
        />
      ),
      title: message.authorName,
      meta: `${place.room.name} › #${place.channel.name} · ${clock(message.createdAt)}`,
      body: <Mentions text={message.body} />,
      tag: { label: 'Mention', accent: true },
    }),
  },
  channel: {
    category: 'messages',
    channel: (item) => item.channelId,
    row: ({ channelId, count, latest }, place) => ({
      key: `channel:${channelId}`,
      place,
      badge: <Badge id={place.room.id} name={place.room.name} size={30} />,
      title: `#${place.channel.name}`,
      meta: `${place.room.name} · ${count} new ${count === 1 ? 'message' : 'messages'}`,
      body: `${latest.authorName}: ${latest.body}`,
      tag: { label: `${count} new`, accent: false },
    }),
  },
} satisfies Registry
const registry: Registry = feed
function project<K extends Kind>(
  kind: K,
  item: ItemOf<K>,
  place: (id: ChannelId) => Place | undefined,
  client: Transport,
) {
  const entry: Entry<K> = registry[kind]
  const found = place(entry.channel(item))
  return found ? [{ category: entry.category, row: entry.row(item, found, client) }] : []
}
const tabs = (Object.keys(categories) as Category[]).filter((category) =>
  Object.values(feed).some((entry) => entry.category === category),
)
function greeting(hour: number) {
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
}
export function Home({
  client,
  session,
  server,
  rooms,
  channels,
  home,
  onView,
  onDialog,
  onMarkAll,
}: {
  client: Transport
  session: Session
  server: Server
  rooms: Room[]
  channels: Channel[]
  home: HomeState
  onView: (view: View) => void
  onDialog: (dialog: Dialog) => void
  onMarkAll: () => Promise<void>
}) {
  const [filter, setFilter] = useState<Category | 'all'>('all')
  const [error, setError] = useState('')
  const now = new Date()
  const admin = server.role === 'admin'
  const place = (id: ChannelId): Place | undefined => {
    const channel = channels.find((channel) => channel.id === id)
    const room = rooms.find((room) => room.id === channel?.roomId)
    return channel && room ? { channel, room } : undefined
  }
  const rows = (home.kind === 'ready' ? home.items : []).flatMap((item) =>
    project(item.kind, item, place, client),
  )
  const visible = rows.filter((row) => filter === 'all' || row.category === filter)
  return (
    <main className="main">
      <header className="topbar">
        <Badge id={server.name} name={server.name} />
        <span className="crumb">{server.name}</span>
        <span className="crumb-separator">/</span>
        <strong>Home</strong>
        {admin && (
          <button className="button topbar-action" onClick={() => onDialog({ kind: 'invite' })}>
            <UserPlus size={15} />
            Invite coworkers
          </button>
        )}
      </header>
      <div className="scroll">
        <div className="home">
          <p className="home-date">
            {now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
          </p>
          <h1 className="home-greeting">
            {greeting(now.getHours())}, {session.user.name.split(/\s+/)[0]}
          </h1>
          {!channels.length ? (
            <Setup server={server} rooms={rooms} channels={channels} onDialog={onDialog} />
          ) : home.kind === 'failed' ? (
            <p className="form-error" role="alert">
              {home.message}
            </p>
          ) : home.kind === 'ready' && !rows.length ? (
            <section className="card caught-up">
              <CircleCheck size={22} />
              <h2>You’re all caught up</h2>
              <p>New mentions and messages from your rooms will show up here.</p>
            </section>
          ) : (
            <section aria-labelledby="feed-title">
              <div className="feed-head">
                <h2 id="feed-title">New for you</h2>
                <div className="tabs" role="tablist" aria-label="Filter">
                  {(['all', ...tabs] as const).map((tab) => (
                    <button
                      key={tab}
                      role="tab"
                      aria-selected={filter === tab}
                      onClick={() => setFilter(tab)}
                    >
                      {tab === 'all' ? 'All' : categories[tab]}
                      <span>
                        {tab === 'all'
                          ? rows.length
                          : rows.filter((row) => row.category === tab).length}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
              <ul className="card feed">
                {visible.map(({ row }) => (
                  <li key={row.key}>
                    <button
                      className="feed-row"
                      onClick={() =>
                        onView({
                          kind: 'room',
                          roomId: row.place.room.id,
                          channelId: row.place.channel.id,
                        })
                      }
                    >
                      <span className="feed-badge">{row.badge}</span>
                      <span className="feed-main">
                        <span className="feed-title">
                          <strong>{row.title}</strong>
                          <span>{row.meta}</span>
                        </span>
                        <span className="feed-body">{row.body}</span>
                      </span>
                      <span className={`tag ${row.tag.accent ? 'accent' : ''}`}>
                        {row.tag.label}
                      </span>
                    </button>
                  </li>
                ))}
                {!visible.length && <li className="feed-empty">Nothing in this filter.</li>}
              </ul>
              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
              <button
                className="link mark-all"
                disabled={!rows.length}
                onClick={() => {
                  setError('')
                  onMarkAll().catch((failure: unknown) => setError(errorText(failure)))
                }}
              >
                Mark all as read
              </button>
            </section>
          )}
        </div>
      </div>
    </main>
  )
}
type Step = {
  title: string
  detail: string
  done: boolean
  action?: { label: string; dialog: Dialog }
}
function Setup({
  server,
  rooms,
  channels,
  onDialog,
}: {
  server: Server
  rooms: Room[]
  channels: Channel[]
  onDialog: (dialog: Dialog) => void
}) {
  const admin = server.role === 'admin'
  const first = rooms[0]
  const invite: Step = {
    title: 'Invite coworkers',
    detail: 'Email an invitation to someone on your team.',
    done: server.memberCount > 1,
    action: { label: 'Invite', dialog: { kind: 'invite' } },
  }
  const steps: Step[] = [
    {
      title: 'Create your first room',
      detail: 'Rooms gather the people and channels for one area of work.',
      done: rooms.length > 0,
      action: { label: 'Create room', dialog: { kind: 'room' } },
    },
    {
      title: 'Add a channel',
      detail: first
        ? `Give ${first.name} a place to talk, like #general.`
        : 'Channels hold the conversation inside a room.',
      done: channels.length > 0,
      action: first && { label: 'Add channel', dialog: { kind: 'channel', roomId: first.id } },
    },
    ...(admin ? [invite] : []),
  ]
  return (
    <section className="card setup" aria-labelledby="setup-title">
      <h2 id="setup-title">Set up {server.name}</h2>
      <p>
        {admin
          ? 'A few steps and your team has a place to talk.'
          : 'An admin is still setting things up. Rooms appear here as soon as they’re created.'}
      </p>
      <ol>
        {steps.map(({ action, ...step }) => (
          <li key={step.title} className={step.done ? 'done' : ''}>
            <span className="step-mark">{step.done && <Check size={13} />}</span>
            <span className="step-text">
              <strong>{step.title}</strong>
              <span>{step.detail}</span>
            </span>
            {admin && !step.done && action && (
              <button className="button" onClick={() => onDialog(action.dialog)}>
                {action.label}
              </button>
            )}
          </li>
        ))}
      </ol>
    </section>
  )
}
