import { Check, MessageSquarePlus, UserPlus } from 'lucide-react'
import type { Channel, ConversationId, Member, Room, Session, Server } from '@huddle/contracts'
import type { Transport } from './transport'
import type { Dialog, DirectRow } from './ServerView'
import { Avatar } from './Avatar'
import { clock, sentence } from './Badges'
import { MemberToggle, shortDate } from './Members'

function greeting(hour: number) {
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
}
function when(iso: string) {
  return new Date(iso).toDateString() === new Date().toDateString() ? clock(iso) : shortDate(iso)
}
export function Home({
  client,
  session,
  server,
  rooms,
  channels,
  members,
  directs,
  onDirect,
  onDialog,
  memberList,
  onMemberList,
}: {
  client: Transport
  session: Session
  server: Server
  rooms: Room[]
  channels: Channel[]
  members: Member[] | null
  directs: DirectRow[]
  onDirect: (conversationId: ConversationId) => void
  onDialog: (dialog: Dialog) => void
  memberList: boolean
  onMemberList: () => void
}) {
  const now = new Date()
  const admin = server.role === 'admin'
  const firstName = session.user.name.split(/\s+/)[0]
  const memberCount = members?.length ?? server.memberCount
  const steps = admin ? adminSteps(rooms, channels, memberCount) : memberSteps(rooms, channels)
  const started = directs.flatMap((direct) =>
    direct.latest ? [{ ...direct, latest: direct.latest }] : [],
  )
  const topbar = (
    <header className="topbar">
      <strong>Home</strong>
      {admin && (
        <button className="button small topbar-action" onClick={() => onDialog({ kind: 'invite' })}>
          <UserPlus size={16} />
          Share invite
        </button>
      )}
      <MemberToggle pressed={memberList} onToggle={onMemberList} />
    </header>
  )
  if (steps.some((step) => !step.done))
    return (
      <main className="main">
        {topbar}
        <div className="scroll">
          <div className="home setup-home">
            <h1 className="home-greeting">
              {admin ? 'Your server is ready' : `You’re in ${sentence(server.name)}`}
            </h1>
            <p className="home-date">Welcome, {firstName}</p>
            <Setup server={server} steps={steps} admin={admin} onDialog={onDialog} />
          </div>
        </div>
      </main>
    )
  return (
    <main className="main">
      {topbar}
      <div className="scroll">
        <div className="home">
          <h1 className="home-greeting">
            {greeting(now.getHours())}, {firstName}
          </h1>
          <p className="home-date">
            {now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
          </p>
          {started.length ? (
            <section aria-labelledby="directs-title">
              <h2 id="directs-title" className="feed-heading">
                Direct messages
              </h2>
              <ul className="feed">
                {started.map((direct) => (
                  <li key={direct.id}>
                    <button className="feed-row" onClick={() => onDirect(direct.id)}>
                      <span className="feed-badge" aria-hidden="true">
                        <Avatar
                          avatar={direct.peer.avatar}
                          name={direct.peer.name}
                          photo={client.photo?.bind(client)}
                          size={32}
                        />
                      </span>
                      <span className="feed-main">
                        <span className="feed-title">
                          <strong>{direct.peer.name}</strong>
                          <span>{when(direct.latest.createdAt)}</span>
                        </span>
                        <span className="feed-body">
                          {direct.latest.authorId === session.user.id && 'You: '}
                          {direct.latest.body}
                        </span>
                      </span>
                      {direct.unread > 0 && <span className="tag accent">{direct.unread} new</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : (
            <section className="home-empty">
              <h2>No messages yet</h2>
              {memberCount > 1 ? (
                <>
                  <p>Start a conversation with anyone on {server.name}.</p>
                  <button className="button primary" onClick={() => onDialog({ kind: 'direct' })}>
                    <MessageSquarePlus size={16} />
                    New message
                  </button>
                </>
              ) : (
                <>
                  <p>You’re the only one here. Invite a friend so you have someone to message.</p>
                  {admin && (
                    <button className="button primary" onClick={() => onDialog({ kind: 'invite' })}>
                      <UserPlus size={16} />
                      Share invite
                    </button>
                  )}
                </>
              )}
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
        : 'Copy an invite. A friend pastes it into Huddle and creates a username.',
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
          <p>
            {admin
              ? 'A few steps and your friends have a place to talk.'
              : 'An admin is still setting things up. Rooms appear here as soon as they’re created.'}
          </p>
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
          You can come back to this list from Home until every step is done. Only admins see it.
        </p>
      )}
    </>
  )
}
