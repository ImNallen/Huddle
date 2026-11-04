import { useRef, useState, type ReactNode } from 'react'
import {
  ArrowLeftRight,
  ChevronDown,
  LogOut,
  Plus,
  Settings,
  Shield,
  UserPlus,
  Users,
} from 'lucide-react'
import type {
  Channel,
  ChannelKind,
  ConversationId,
  Room,
  RoomId,
  Session,
  Server,
} from '@huddle/contracts'
import type { Transport } from './transport'
import { threadKey, type Activity, type Unread } from './useServer'
import type { Dialog, DirectRow, View } from './ServerView'
import { roleLabels } from './Members'
import { Avatar } from './Avatar'
import { ChannelIcon, initials } from './Badges'
import { Logo } from './primitives'

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
  hints,
  onClick,
  children,
}: {
  name: string
  badge?: number
  description?: string
  current?: boolean
  pill?: boolean
  hints: RailHints
  onClick: () => void
  children: ReactNode
}) {
  return (
    <div className={`rail-item ${current ? 'current' : ''} ${pill ? 'unread' : ''}`}>
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
    <nav className="rail" aria-label="Rooms" onScroll={place}>
      <RailTile
        name="Home"
        badge={homeCount}
        description={describeActivity({ count: homeCount, mentions: 0 })}
        current={view.kind !== 'room'}
        hints={hints}
        onClick={() => onView({ kind: 'home' })}
      >
        <Logo size={24} />
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
          <Plus size={20} />
        </RailTile>
      )}
      {onServer && (
        <RailTile name="Switch server" hints={hints} onClick={onServer}>
          <ArrowLeftRight size={20} />
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
            title={create.name}
            onClick={create.onClick}
          >
            <Plus size={16} />
          </button>
        )}
      </div>
      {children}
    </>
  )
}
const channelSections: { kind: ChannelKind; label: string; create: string }[] = [
  { kind: 'text', label: 'Text Channels', create: 'Create text channel' },
  { kind: 'voice', label: 'Voice Channels', create: 'Create voice channel' },
]
export function Sidebar({
  client,
  session,
  server,
  rooms,
  channels,
  unread,
  directs,
  view,
  connection,
  onView,
  onDirect,
  onRoom,
  onDialog,
  onSecurity,
  onLogout,
  onServer,
}: {
  client: Transport
  session: Session
  server: Server
  rooms: Room[]
  channels: Channel[]
  unread: Unread
  directs: DirectRow[]
  view: View
  connection: string
  onView: (view: View) => void
  onDirect: (conversationId: ConversationId) => void
  onRoom: (roomId: RoomId) => void
  onDialog: (dialog: Dialog) => void
  onSecurity: () => void
  onLogout: () => void
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
  const menu = useRef<HTMLDivElement>(null)
  const act = (action: () => void) => () => {
    menu.current?.hidePopover()
    action()
  }
  return (
    <>
      <Rail
        rooms={rooms}
        roomActivity={roomActivity}
        admin={admin}
        homeCount={directs.reduce((total, direct) => total + direct.unread, 0)}
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
        <div ref={menu} id="server-menu" popover="auto" className="menu">
          {admin && (
            <button onClick={act(() => onDialog({ kind: 'invite' }))}>
              <UserPlus size={16} />
              <span>Share invite</span>
            </button>
          )}
          <button onClick={act(onSecurity)}>
            <Shield size={16} />
            <span>Security settings</span>
          </button>
          <hr />
          <button className="menu-danger" onClick={act(onLogout)}>
            <LogOut size={16} />
            <span>Sign out</span>
          </button>
        </div>
        <nav className="sidebar-nav" aria-label={room ? `${room.name} channels` : server.name}>
          {admin && (
            <button
              className="nav-row members-row"
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
                      return (
                        <button
                          key={channel.id}
                          className={`nav-row ${count ? 'unread' : ''}`}
                          aria-current={current ? 'page' : undefined}
                          onClick={() =>
                            onView({ kind: 'room', roomId: room.id, channelId: channel.id })
                          }
                        >
                          <ChannelIcon kind={channel.kind} size={18} />
                          <span>{channel.name}</span>
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
                      )
                    })}
                  </Section>
                )
              })}
              {!admin && !roomChannels.length && <p className="sidebar-note">No channels yet.</p>}
            </>
          ) : (
            <Section
              label="Direct Messages"
              create={{ name: 'New message', onClick: () => onDialog({ kind: 'direct' }) }}
            >
              {directs.map((direct) => (
                <button
                  key={direct.id}
                  className={`nav-row direct-row ${direct.unread ? 'unread' : ''}`}
                  aria-current={
                    view.kind === 'direct' && view.conversationId === direct.id ? 'page' : undefined
                  }
                  onClick={() => onDirect(direct.id)}
                >
                  <i className="avatar-slot" aria-hidden="true">
                    <Avatar
                      avatar={direct.peer.avatar}
                      name={direct.peer.name}
                      photo={client.photo?.bind(client)}
                      size={24}
                    />
                  </i>
                  <span>{direct.peer.name}</span>
                  {direct.unread > 0 && (
                    <>
                      <i className="unread-pill" />
                      <span className="sr-only">unread</span>
                    </>
                  )}
                </button>
              ))}
              {!directs.length && <p className="sidebar-note">No messages yet.</p>}
            </Section>
          )}
        </nav>
      </aside>
      <footer className="account">
        <span className="account-avatar">
          <Avatar
            avatar={session.user.avatar}
            name={session.user.name}
            photo={client.photo?.bind(client)}
            size={32}
          />
          <i className={`presence ${connection === 'Connected' ? 'online' : ''}`} />
        </span>
        <span className="account-name">
          <strong>{session.user.name}</strong>
          <span>{connection === 'Connected' ? roleLabels[server.role] : connection}</span>
          <span className="sr-only" role="status">
            {connection}
          </span>
        </span>
        <button
          className="icon-button"
          aria-label="Account security"
          title="Account security"
          onClick={onSecurity}
        >
          <Settings size={18} />
        </button>
      </footer>
    </>
  )
}
