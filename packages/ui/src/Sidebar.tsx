import { Fragment, useRef, useState, type ReactNode } from 'react'
import { ArrowLeftRight, ChevronDown, Plus, Settings, Users } from 'lucide-react'
import type {
  Channel,
  ChannelKind,
  ConversationId,
  Room,
  RoomId,
  Me,
  Member,
  Server,
  VoicePresence,
} from '@huddle/contracts'
import { GroupIcon } from './GroupChat'
import type { GroupRow } from './chat'
import type { Transport } from './transport'
import { threadKey, type Activity, type Unread } from './useServer'
import type { Dialog, DirectRow, View } from './ServerView'
import { Avatar } from './Avatar'
import { ChannelIcon, initials } from './Badges'
import { Logo } from './primitives'
import { Popover } from './Popover'
import { CallPanel } from './Voice'
import type { VoiceCall } from './voiceCall'

type Hint = { name: string; top: number; left: number; shown: boolean }
type RailHints = { show: (name: string, tile: HTMLElement) => void; hide: () => void }
function describeActivity({ count, mentions }: Activity) {
  if (!count) return undefined
  if (!mentions) return `${count} unread`
  return `${count} unread, ${mentions} ${mentions === 1 ? 'mention' : 'mentions'}`
}
function RailTile({
  name,
  badge = 0,
  description,
  current = false,
  pill = false,
  bottom = false,
  hints,
  onClick,
  children,
}: {
  name: string
  badge?: number
  description?: string
  current?: boolean
  pill?: boolean
  bottom?: boolean
  hints: RailHints
  onClick: () => void
  children: ReactNode
}) {
  return (
    <div
      className={`rail-item ${current ? 'current' : ''} ${pill ? 'unread' : ''} ${bottom ? 'bottom' : ''}`}
    >
      <i className="rail-pill" />
      <button
        className="rail-tile"
        aria-label={name}
        aria-description={description}
        aria-current={current ? 'true' : undefined}
        onClick={onClick}
        onPointerEnter={(event) => hints.show(name, event.currentTarget)}
        onPointerLeave={hints.hide}
        onFocus={(event) => {
          if (event.currentTarget.matches(':focus-visible')) hints.show(name, event.currentTarget)
        }}
        onBlur={hints.hide}
      >
        {children}
        {badge > 0 && <span className="rail-count">{badge}</span>}
      </button>
    </div>
  )
}
function Rail({
  rooms,
  roomActivity,
  admin,
  homeCount,
  view,
  onView,
  onRoom,
  onDialog,
  onServer,
}: {
  rooms: Room[]
  roomActivity: (roomId: RoomId) => Activity
  admin: boolean
  homeCount: number
  view: View
  onView: (view: View) => void
  onRoom: (roomId: RoomId) => void
  onDialog: (dialog: Dialog) => void
  onServer?: () => void
}) {
  const [hint, setHint] = useState<Hint>({ name: '', top: 0, left: 0, shown: false })
  const anchor = useRef<{ name: string; tile: HTMLElement } | null>(null)
  function place() {
    if (!anchor.current) return
    const { name, tile } = anchor.current
    const box = tile.getBoundingClientRect()
    setHint({ name, top: box.top + box.height / 2, left: box.right + 12, shown: true })
  }
  const hints: RailHints = {
    show(name, tile) {
      anchor.current = { name, tile }
      place()
    },
    hide() {
      anchor.current = null
      setHint((current) => ({ ...current, shown: false }))
    },
  }
  return (
    <nav
      className="rail"
      aria-label="Rooms"
      onScroll={place}
      onKeyDown={(event) => {
        if (event.key === 'Escape') hints.hide()
      }}
    >
      <RailTile
        name="Home"
        badge={homeCount}
        description={describeActivity({ count: homeCount, mentions: 0 })}
        current={view.kind !== 'room'}
        hints={hints}
        onClick={() => onView({ kind: 'home' })}
      >
        <Logo size={36} />
      </RailTile>
      <i className="rail-separator" />
      {rooms.map((room) => {
        const activity = roomActivity(room.id)
        return (
          <RailTile
            key={room.id}
            name={room.name}
            badge={activity.mentions}
            description={describeActivity(activity)}
            current={view.kind === 'room' && view.roomId === room.id}
            pill={activity.count > 0}
            hints={hints}
            onClick={() => onRoom(room.id)}
          >
            {initials(room.name)}
          </RailTile>
        )
      })}
      {admin && (
        <RailTile name="Create room" hints={hints} onClick={() => onDialog({ kind: 'room' })}>
          <Plus size={18} />
        </RailTile>
      )}
      {onServer && (
        <RailTile bottom name="Switch server" hints={hints} onClick={onServer}>
          <ArrowLeftRight size={18} />
        </RailTile>
      )}
      <span
        className={`rail-tooltip ${hint.shown ? 'shown' : ''}`}
        style={{ top: hint.top, left: hint.left }}
        aria-hidden="true"
      >
        {hint.name}
      </span>
    </nav>
  )
}
function Section({
  label,
  create,
  children,
}: {
  label: string
  create: { name: string; onClick: () => void } | null
  children: ReactNode
}) {
  return (
    <>
      <div className="section-label">
        <span>{label}</span>
        {create && (
          <button
            className="icon-button"
            aria-label={create.name}
            data-tooltip={create.name}
            onClick={create.onClick}
          >
            <Plus size={14} />
          </button>
        )}
      </div>
      {children}
    </>
  )
}
const channelSections: { kind: ChannelKind; label: string; create: string }[] = [
  { kind: 'text', label: 'Text channels', create: 'Create text channel' },
  { kind: 'voice', label: 'Voice channels', create: 'Create voice channel' },
]
export function Sidebar({
  client,
  me,
  server,
  rooms,
  channels,
  unread,
  directs,
  groups,
  view,
  connection,
  voice,
  presence,
  members,
  onView,
  onDirect,
  onRoom,
  onDialog,
  onSettings,
  onServer,
}: {
  client: Transport
  me: Me
  server: Server
  rooms: Room[]
  channels: Channel[]
  unread: Unread
  directs: DirectRow[]
  groups: GroupRow[]
  view: View
  connection: string
  voice: VoiceCall
  presence: VoicePresence
  members: Member[] | null
  onView: (view: View) => void
  onDirect: (conversationId: ConversationId) => void
  onRoom: (roomId: RoomId) => void
  onDialog: (dialog: Dialog) => void
  onSettings: () => void
  onServer?: () => void
}) {
  const admin = server.role === 'admin'
  const room = view.kind === 'room' ? rooms.find((room) => room.id === view.roomId) : undefined
  const title = room?.name ?? server.name
  const roomChannels = channels.filter((channel) => channel.roomId === room?.id)
  const channelActivity = (channel: Channel) =>
    unread.get(threadKey({ kind: 'channel', id: channel.id })) ?? { count: 0, mentions: 0 }
  const roomActivity = (roomId: RoomId) =>
    channels
      .filter((channel) => channel.roomId === roomId)
      .map(channelActivity)
      .reduce(
        (total, { count, mentions }) => ({
          count: total.count + count,
          mentions: total.mentions + mentions,
        }),
        { count: 0, mentions: 0 },
      )
  return (
    <>
      <Rail
        rooms={rooms}
        roomActivity={roomActivity}
        admin={admin}
        homeCount={
          directs.reduce((total, direct) => total + direct.unread, 0) +
          groups.reduce((total, group) => total + group.unread, 0)
        }
        view={view}
        onView={onView}
        onRoom={onRoom}
        onDialog={onDialog}
        onServer={onServer}
      />
      <aside className="sidebar">
        <button className="sidebar-header" popoverTarget="server-menu" aria-label={`${title} menu`}>
          <strong>{title}</strong>
          <ChevronDown size={18} />
        </button>
        <Popover id="server-menu" label={`${title} actions`} menu align="start">
          <p className="menu-context">{title}</p>
          {admin && room && (
            <button
              type="button"
              onClick={() => onDialog({ kind: 'channel', roomId: room.id, channelKind: 'text' })}
            >
              Create a channel
            </button>
          )}
          {admin && !room && (
            <button type="button" onClick={() => onView({ kind: 'members' })}>
              Members
            </button>
          )}
          {admin && (
            <button type="button" onClick={() => onDialog({ kind: 'room' })}>
              Create a room
            </button>
          )}
          {admin && <hr />}
          <button type="button" onClick={onSettings}>
            Settings
          </button>
          {!room && onServer && (
            <button type="button" onClick={onServer}>
              Switch server
            </button>
          )}
        </Popover>
        <nav
          className={`sidebar-nav ${room ? '' : 'home-nav'}`}
          aria-label={room ? `${room.name} channels` : server.name}
        >
          {!room && (
            <button
              className="nav-row home-nav-row"
              aria-current={view.kind === 'home' ? 'page' : undefined}
              onClick={() => onView({ kind: 'home' })}
            >
              <Logo size={24} />
              <span>Home</span>
            </button>
          )}
          {!room && admin && (
            <button
              className="nav-row home-nav-row"
              aria-current={view.kind === 'members' ? 'page' : undefined}
              onClick={() => onView({ kind: 'members' })}
            >
              <Users size={18} />
              <span>Members</span>
            </button>
          )}
          {room ? (
            <>
              {channelSections.map((section) => {
                const listed = roomChannels.filter((channel) => channel.kind === section.kind)
                if (!admin && !listed.length) return null
                return (
                  <Section
                    key={section.kind}
                    label={section.label}
                    create={
                      admin
                        ? {
                            name: section.create,
                            onClick: () =>
                              onDialog({
                                kind: 'channel',
                                roomId: room.id,
                                channelKind: section.kind,
                              }),
                          }
                        : null
                    }
                  >
                    {listed.map((channel) => {
                      const { count, mentions } = channelActivity(channel)
                      const current = view.kind === 'room' && view.channelId === channel.id
                      const inCall =
                        (voice.call.phase === 'connected' || voice.call.phase === 'reconnecting') &&
                        voice.call.channelId === channel.id
                      const present = presence.find(({ channelId }) => channelId === channel.id)
                      return (
                        <Fragment key={channel.id}>
                          <button
                            className={`nav-row ${count ? 'unread' : ''} ${inCall ? 'in-call' : ''}`}
                            aria-current={current ? 'page' : undefined}
                            onClick={() =>
                              onView({ kind: 'room', roomId: room.id, channelId: channel.id })
                            }
                          >
                            <ChannelIcon kind={channel.kind} size={18} />
                            <span>{channel.name}</span>
                            {inCall && (
                              <>
                                <span className="voice-in-call" aria-hidden="true">
                                  In call
                                </span>
                                <span className="sr-only">you're in this call</span>
                              </>
                            )}
                            {mentions > 0 && (
                              <b className="nav-count">
                                {mentions}
                                <span className="sr-only">
                                  {mentions === 1 ? ' mention' : ' mentions'}
                                </span>
                              </b>
                            )}
                            {count > 0 && (
                              <>
                                <i className="unread-pill" />
                                <span className="sr-only">unread</span>
                              </>
                            )}
                          </button>
                          {present && (
                            <ul className="channel-people" aria-label={`In ${channel.name}`}>
                              {present.people.map((person) => {
                                const member = members?.find(({ id }) => id === person.id)
                                const name = member?.name ?? person.name
                                return (
                                  <li key={person.id}>
                                    <Avatar
                                      avatar={member?.avatar}
                                      name={name}
                                      photo={client.photo?.bind(client)}
                                      size={20}
                                    />
                                    <span>{person.id === me.user.id ? 'You' : name}</span>
                                  </li>
                                )
                              })}
                            </ul>
                          )}
                        </Fragment>
                      )
                    })}
                  </Section>
                )
              })}
              {!admin && !roomChannels.length && <p className="sidebar-note">No channels yet.</p>}
            </>
          ) : (
            <Section
              label={groups.length ? 'Messages' : 'Direct messages'}
              create={{ name: 'New message', onClick: () => onDialog({ kind: 'direct' }) }}
            >
              {[
                ...groups.map((group) => ({
                  kind: 'group' as const,
                  group,
                  cursor: group.latest?.cursor ?? group.revision,
                })),
                ...directs.map((direct) => ({
                  kind: 'direct' as const,
                  direct,
                  cursor: direct.latest?.cursor ?? '0',
                })),
              ]
                .sort((a, b) => (BigInt(a.cursor) > BigInt(b.cursor) ? -1 : 1))
                .map((row) =>
                  row.kind === 'group' ? (
                    <button
                      key={row.group.id}
                      className={`nav-row direct-row ${row.group.unread ? 'unread' : ''}`}
                      aria-current={
                        view.kind === 'group' && view.thread.id === row.group.id
                          ? 'page'
                          : undefined
                      }
                      onClick={() => onView({ kind: 'group', thread: row.group.thread })}
                    >
                      <GroupIcon />
                      <span>{row.group.name}</span>
                      {row.group.unread > 0 && (
                        <b className="direct-count">
                          {row.group.unread}
                          <span className="sr-only"> unread</span>
                        </b>
                      )}
                    </button>
                  ) : (
                    (() => {
                      const direct = row.direct
                      return (
                        <button
                          key={direct.id}
                          className={`nav-row direct-row ${direct.unread ? 'unread' : ''}`}
                          aria-current={
                            view.kind === 'direct' && view.conversationId === direct.id
                              ? 'page'
                              : undefined
                          }
                          onClick={() => onDirect(direct.id)}
                        >
                          <i className="avatar-slot" aria-hidden="true">
                            <Avatar
                              avatar={direct.peer.avatar}
                              name={direct.peer.name}
                              photo={client.photo?.bind(client)}
                              size={28}
                            />
                          </i>
                          <span>{direct.peer.name}</span>
                          {direct.unread > 0 && (
                            <b className="direct-count">
                              {direct.unread}
                              <span className="sr-only"> unread</span>
                            </b>
                          )}
                        </button>
                      )
                    })()
                  ),
                )}
              {!groups.length && !directs.length && (
                <p className="sidebar-note">No messages yet.</p>
              )}
            </Section>
          )}
        </nav>
      </aside>
      <CallPanel
        voice={voice}
        channels={channels}
        rooms={rooms}
        viewing={view.kind === 'room' ? view.channelId : null}
        onOpen={(channel) =>
          onView({ kind: 'room', roomId: channel.roomId, channelId: channel.id })
        }
      />
      <footer className="account">
        <span className="account-avatar">
          <Avatar
            avatar={me.user.avatar}
            name={me.user.name}
            photo={client.photo?.bind(client)}
            size={32}
          />
        </span>
        <span className="account-name">
          <strong>{me.user.name}</strong>
          <span>{connection}</span>
          <span className="sr-only" role="status">
            {connection}
          </span>
        </span>
        <button
          className="icon-button"
          aria-label="Settings"
          data-tooltip="Settings"
          onClick={onSettings}
        >
          <Settings size={18} />
        </button>
      </footer>
    </>
  )
}
