import { useState, type ReactNode } from 'react'
import { Check, CircleCheck, UserPlus } from 'lucide-react'
import type { Channel, ChannelId, HomeItem, Member, Room, Session, Server } from '@huddle/contracts'
import { errorText, type Transport } from './transport'
import type { Dialog, HomeState, View } from './ServerView'
import { Avatar } from './Avatar'
import { Badge, Mentions, clock, sentence } from './Badges'

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
  members,
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
  members: Member[] | null
  home: HomeState
  onView: (view: View) => void
  onDialog: (dialog: Dialog) => void
  onMarkAll: () => Promise<void>
}) {
  const [filter, setFilter] = useState<Category | 'all'>('all')
  const [error, setError] = useState('')
  const now = new Date()
  const admin = server.role === 'admin'
  const firstName = session.user.name.split(/\s+/)[0]
  const steps = admin
    ? adminSteps(rooms, channels, members?.length ?? server.memberCount)
    : memberSteps(
        rooms,
        channels,
        members?.find((member) => member.id === session.user.id)?.invitedBy ?? null,
      )
  const place = (id: ChannelId): Place | undefined => {
    const channel = channels.find((channel) => channel.id === id)
    const room = rooms.find((room) => room.id === channel?.roomId)
    return channel && room ? { channel, room } : undefined
  }
  const rows = (home.kind === 'ready' ? home.items : []).flatMap((item) =>
    project(item.kind, item, place, client),
  )
  const visible = rows.filter((row) => filter === 'all' || row.category === filter)
  if (steps.some((step) => !step.done))
    return (
      <main className="main">
        <header className="topbar">
          <strong>Home</strong>
          {admin && (
            <button className="button topbar-action" onClick={() => onDialog({ kind: 'invite' })}>
              <UserPlus size={15} />
              Invite
            </button>
          )}
        </header>
        <div className="scroll">
          <div className="home setup-home">
            <p className="home-date">Welcome, {firstName}</p>
            <h1 className="home-greeting">
              {admin ? 'Your server is ready' : `You’re in ${sentence(server.name)}`}
            </h1>
            <Setup server={server} steps={steps} admin={admin} onDialog={onDialog} />
          </div>
        </div>
      </main>
    )
  return (
    <main className="main">
      <header className="topbar">
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
            {greeting(now.getHours())}, {firstName}
          </h1>
          {home.kind === 'failed' ? (
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
  action: { label: string; dialog: Dialog | null } | null
}
const channelPurpose = 'Channels are where a room’s conversations happen.'
function placed(rooms: Room[], channels: Channel[]) {
  const channel = channels[0]
  const room = rooms.find((room) => room.id === channel?.roomId)
  return channel && room ? `#${channel.name} in ${room.name}` : null
}
function adminSteps(rooms: Room[], channels: Channel[], memberCount: number): Step[] {
  const room = rooms[0]
  const channel = placed(rooms, channels)
  const coworkers = memberCount - 1
  return [
    {
      title: 'Create your first room',
      detail: room?.name ?? 'A room holds the channels for one team or area of work.',
      done: Boolean(room),
      action: { label: 'Create room', dialog: { kind: 'room' } },
    },
    {
      title: 'Add a channel',
      detail: channel ?? (room ? channelPurpose : `${channelPurpose} Create a room first.`),
      done: Boolean(channel),
      action: { label: 'Add channel', dialog: room ? { kind: 'channel', roomId: room.id } : null },
    },
    {
      title: 'Invite coworkers',
      detail: coworkers
        ? `${coworkers} ${coworkers === 1 ? 'coworker has' : 'coworkers have'} joined.`
        : 'Huddle emails them an invitation that lasts 7 days.',
      done: coworkers > 0,
      action: { label: 'Invite coworkers', dialog: { kind: 'invite' } },
    },
  ]
}
function memberSteps(rooms: Room[], channels: Channel[], invitedBy: string | null): Step[] {
  const room = rooms[0]
  const channel = placed(rooms, channels)
  return [
    {
      title: 'Invite coworkers',
      detail: `You joined from ${invitedBy ? `${invitedBy}’s` : 'an'} invitation.`,
      done: true,
      action: null,
    },
    {
      title: 'Create the first room',
      detail: room?.name ?? 'A room holds the channels for one team or area of work.',
      done: Boolean(room),
      action: null,
    },
    {
      title: 'Add a channel',
      detail: channel ?? channelPurpose,
      done: Boolean(channel),
      action: null,
    },
  ]
}
function Setup({
  server,
  steps,
  admin,
  onDialog,
}: {
  server: Server
  steps: Step[]
  admin: boolean
  onDialog: (dialog: Dialog) => void
}) {
  const done = steps.filter((step) => step.done).length
  const next = steps.findIndex((step) => !step.done)
  return (
    <>
      <section className="card setup" aria-labelledby="setup-title">
        <div className="setup-head">
          <h2 id="setup-title">Set up {server.name}</h2>
          <span className="setup-count">
            {done} of {steps.length} done
          </span>
          <p>
            {admin
              ? 'A few steps and your team has a place to talk.'
              : 'An admin is still setting things up. Rooms appear here as soon as they’re created.'}
          </p>
          <span className="setup-progress" aria-hidden="true">
            {steps.map((step, index) => (
              <i key={step.title} className={index < done ? 'filled' : ''} />
            ))}
          </span>
        </div>
        <ol>
          {steps.map((step, index) => (
            <li key={step.title}>
              <span
                className={`step-mark ${step.done ? 'done' : !admin ? 'waiting' : index === next ? 'next' : ''}`}
              >
                {step.done ? <Check size={13} /> : admin ? index + 1 : null}
              </span>
              <span className="step-text">
                <strong>{step.title}</strong>
                <span>{step.detail}</span>
              </span>
              {step.done ? (
                <span className="step-state done">Done</span>
              ) : step.action ? (
                <button
                  className={`button ${index === next ? 'primary' : ''}`}
                  disabled={!step.action.dialog}
                  onClick={() => step.action?.dialog && onDialog(step.action.dialog)}
                >
                  {step.action.label}
                </button>
              ) : (
                <span className="step-state">Waiting on an admin</span>
              )}
            </li>
          ))}
        </ol>
      </section>
      {admin && (
        <p className="setup-note">
          You can come back to this list from Home until every step is done. Only admins see it.
        </p>
      )}
    </>
  )
}
