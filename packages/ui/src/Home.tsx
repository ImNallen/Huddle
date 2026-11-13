import { Check, Plus, Volume2 } from 'lucide-react'
import {
  plainText,
  type Channel,
  type ConversationId,
  type Member,
  type Room,
  type RoomId,
  type Me,
  type Server,
  type VoicePresence,
} from '@huddle/contracts'
import { GroupIcon } from './GroupChat'
import type { GroupRow, GroupThread } from './chat'
import type { Transport } from './transport'
import type { Dialog, DirectRow } from './ServerView'
import { threadKey, type Unread } from './useServer'
import { Avatar } from './Avatar'
import { clock, sentence } from './Badges'
import { MemberToggle, shortDate } from './Members'

function greeting(hour: number) {
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
}
function when(iso: string) {
  const date = new Date(iso)
  const today = new Date()
  if (date.toDateString() === today.toDateString()) return clock(iso)
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  return date.toDateString() === yesterday.toDateString() ? 'Yesterday' : shortDate(iso)
}
function activityInRoom(room: Room, channels: Channel[], unread: Unread) {
  const inRoom = channels.filter((channel) => channel.roomId === room.id)
  const active = inRoom.flatMap((channel) => {
    const count = unread.get(threadKey({ kind: 'channel', id: channel.id }))?.count ?? 0
    return count ? [{ channel, count }] : []
  })
  const [first] = active
  if (!first) return inRoom.length ? 'A place to catch up' : 'No channels yet'
  if (active.length === 1) return `${first.count} new in #${first.channel.name}`
  return `${active.reduce((total, item) => total + item.count, 0)} new across ${active.length} channels`
}
export function Home({
  client,
  me,
  server,
  rooms,
  channels,
  members,
  directs,
  groups,
  onGroup,
  unread,
  presence,
  onDirect,
  onRoom,
  onChannel,
  onDialog,
  memberList,
  onMemberList,
}: {
  client: Transport
  me: Me
  server: Server
  rooms: Room[]
  channels: Channel[]
  members: Member[] | null
  directs: DirectRow[]
  groups: GroupRow[]
  onGroup: (thread: GroupThread) => void
  unread: Unread
  presence: VoicePresence
  onDirect: (conversationId: ConversationId) => void
  onRoom: (roomId: RoomId) => void
  onChannel: (channel: Channel) => void
  onDialog: (dialog: Dialog) => void
  memberList: boolean
  onMemberList: () => void
}) {
  const now = new Date()
  const admin = server.role === 'admin'
  const [firstName = me.user.name] = me.user.name.split(/\s+/)
  const memberCount = members?.length ?? server.memberCount
  const steps = admin ? adminSteps(rooms, channels, memberCount) : memberSteps(rooms, channels)
  const started = directs.flatMap((direct) =>
    direct.latest ? [{ ...direct, latest: direct.latest }] : [],
  )
  const activeVoice = presence.flatMap((present) => {
    const channel = channels.find(
      (channel) => channel.id === present.channelId && channel.kind === 'voice',
    )
    const room = rooms.find((room) => room.id === channel?.roomId)
    return channel && room && present.people.length ? [{ ...present, channel, room }] : []
  })
  const topbar = (
    <header className="topbar">
      <strong>Home</strong>
      <div className="channel-actions">
        {admin && (
          <button className="header-pill" onClick={() => onDialog({ kind: 'invite' })}>
            Share invite
          </button>
        )}
        <MemberToggle pressed={memberList} onToggle={onMemberList} count={memberCount} />
      </div>
    </header>
  )
  if (steps.some((step) => !step.done))
    return (
      <main className="main">
        {topbar}
        <div className="scroll">
          <div className="home setup-home">
            <h1 className="home-greeting" aria-label={admin ? 'Your server is ready' : undefined}>
              {admin ? 'Your server is ready.' : `You’re in ${sentence(server.name)}`}
            </h1>
            <p className="home-date">
              {admin
                ? 'A few steps and your friends have a place to talk.'
                : `Welcome, ${firstName}`}
            </p>
            <Setup server={server} steps={steps} admin={admin} onDialog={onDialog} />
          </div>
        </div>
      </main>
    )
  return (
    <main className="main">
      {topbar}
      <div className="scroll">
        <div className="home home-dashboard">
          <div className="home-welcome">
            <h1 className="home-greeting">
              {greeting(now.getHours())}, {firstName}.
            </h1>
            <p className="home-date">
              {now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
            </p>
          </div>
          <section className="home-directs" aria-labelledby="directs-title">
            <div className="home-section-heading">
              <h2 id="directs-title">{groups.length ? 'Messages' : 'Direct messages'}</h2>
              <button className="header-pill" onClick={() => onDialog({ kind: 'direct' })}>
                <Plus size={16} strokeWidth={1.6} />
                New message
              </button>
            </div>
            {started.length || groups.length ? (
              <ul className="feed">
                {[
                  ...groups.map((group) => ({
                    id: group.id,
                    name: group.name,
                    latest: group.latest,
                    unread: group.unread,
                    cursor: group.latest?.cursor ?? group.revision,
                    icon: <GroupIcon size={40} />,
                    open: () => onGroup(group.thread),
                    empty: `${group.members.length} people · Start the conversation`,
                  })),
                  ...started.map((direct) => ({
                    id: direct.id,
                    name: direct.peer.name,
                    latest: direct.latest,
                    unread: direct.unread,
                    cursor: direct.latest.cursor,
                    icon: (
                      <Avatar
                        avatar={direct.peer.avatar}
                        name={direct.peer.name}
                        photo={client.photo?.bind(client)}
                        size={40}
                      />
                    ),
                    open: () => onDirect(direct.id),
                    empty: '',
                  })),
                ]
                  .sort((a, b) => (BigInt(a.cursor) > BigInt(b.cursor) ? -1 : 1))
                  .map((row) => (
                    <li key={row.id}>
                      <button
                        className={`feed-row ${row.unread ? 'unread' : ''}`}
                        onClick={row.open}
                      >
                        <span className="feed-badge" aria-hidden="true">
                          {row.icon}
                        </span>
                        <span className="feed-main">
                          <strong>{row.name}</strong>
                          <span className="feed-body">
                            {row.latest?.authorId === me.user.id && 'You: '}
                            {row.latest ? plainText(row.latest.content) : row.empty}
                          </span>
                        </span>
                        <span className="feed-meta">
                          {row.latest && (
                            <time dateTime={row.latest.createdAt}>
                              {when(row.latest.createdAt)}
                            </time>
                          )}
                          {row.unread > 0 && <span className="feed-unread">{row.unread} new</span>}
                        </span>
                      </button>
                    </li>
                  ))}
              </ul>
            ) : (
              <div className="home-empty">
                <h3>No messages yet</h3>
                <p>Start a conversation with anyone on {server.name}.</p>
              </div>
            )}
          </section>
          <section className="home-rooms" aria-labelledby="rooms-title">
            <h2 id="rooms-title">Your rooms</h2>
            <ul>
              {rooms.map((room) => (
                <li key={room.id}>
                  <button className="home-room-card" onClick={() => onRoom(room.id)}>
                    <span className="home-room-title">
                      <strong>{room.name}</strong>
                      <span aria-hidden="true">↗</span>
                    </span>
                    <span className="home-room-activity">
                      {activityInRoom(room, channels, unread)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
          {activeVoice.length > 0 && (
            <section className="home-voice-list" aria-label="People in voice">
              {activeVoice.map(({ channel, room, people }) => {
                const names = people.map(
                  (person) =>
                    members?.find((member) => member.id === person.id)?.name ?? person.name,
                )
                const who = new Intl.ListFormat(undefined, {
                  style: 'long',
                  type: 'conjunction',
                }).format(names)
                return (
                  <div className="home-voice" key={channel.id}>
                    <Volume2 size={20} strokeWidth={1.6} aria-hidden="true" />
                    <div className="home-voice-copy">
                      <strong>A little company?</strong>
                      <p>
                        {who} {people.length === 1 ? 'is' : 'are'} in {channel.name} · {room.name}
                      </p>
                    </div>
                    <button className="header-pill" onClick={() => onChannel(channel)}>
                      Open {channel.name}
                    </button>
                  </div>
                )
              })}
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
const channelPurpose = 'Channels hold the conversation.'
function placed(rooms: Room[], channels: Channel[]) {
  const channel = channels.find((channel) => channel.kind === 'text') ?? channels[0]
  const room = rooms.find((room) => room.id === channel?.roomId)
  if (!channel || !room) return null
  return `${channel.kind === 'text' ? '#' : ''}${channel.name} in ${room.name}`
}
function adminSteps(rooms: Room[], channels: Channel[], memberCount: number): Step[] {
  const room = rooms[0]
  const channel = placed(rooms, channels)
  const coworkers = memberCount - 1
  return [
    {
      title: 'Create your first room',
      detail: room?.name ?? 'A room holds the channels for one group.',
      done: Boolean(room),
      action: { label: 'Create room', dialog: { kind: 'room' } },
    },
    {
      title: 'Add a channel',
      detail: channel ?? (room ? channelPurpose : `${channelPurpose} Create a room first.`),
      done: Boolean(channel),
      action: {
        label: 'Add channel',
        dialog: room ? { kind: 'channel', roomId: room.id, channelKind: 'text' } : null,
      },
    },
    {
      title: 'Share Huddle',
      detail: coworkers
        ? `${coworkers} ${coworkers === 1 ? 'friend has' : 'friends have'} joined.`
        : 'Friends need access to this machine in Tailscale.',
      done: coworkers > 0,
      action: { label: 'Share invite', dialog: { kind: 'invite' } },
    },
  ]
}
function memberSteps(rooms: Room[], channels: Channel[]): Step[] {
  const room = rooms[0]
  const channel = placed(rooms, channels)
  return [
    {
      title: 'You joined this server',
      detail: 'You joined from an invite.',
      done: true,
      action: null,
    },
    {
      title: 'Create the first room',
      detail: room?.name ?? 'A room holds the channels for one group.',
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
      <section className="setup" aria-labelledby="setup-title">
        <div className="setup-head">
          <h2 id="setup-title">Set up {server.name}</h2>
          <span className="setup-count">
            {done} of {steps.length} done
          </span>
          {!admin && (
            <p>
              An admin is still setting things up. Rooms appear here as soon as they’re created.
            </p>
          )}
        </div>
        <ol>
          {steps.map((step, index) => (
            <li key={step.title}>
              <span
                className={`step-mark ${step.done ? 'done' : !admin ? 'waiting' : index === next ? 'next' : ''}`}
              >
                {step.done ? <Check size={14} strokeWidth={3} /> : admin ? index + 1 : null}
              </span>
              <span className="step-text">
                <strong>{step.title}</strong>
                <span>{step.detail}</span>
              </span>
              {step.done ? (
                <span className="step-state">Done</span>
              ) : step.action ? (
                <button
                  className={`button small ${index === next ? 'primary' : ''}`}
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
          You can return to this checklist from Home until every step is done.
        </p>
      )}
    </>
  )
}
