import { useRef, type ReactNode } from 'react'
import {
  Check,
  ChevronDown,
  Hash,
  House,
  LogIn,
  LogOut,
  Plus,
  Server,
  Settings,
  Shield,
  UserPlus,
} from 'lucide-react'
import type { Channel, Room, RoomId, Session, Workspace } from '@huddle/contracts'
import type { Transport } from './transport'
import type { Unread } from './useWorkspace'
import type { Dialog, View } from './WorkspaceView'
import { Avatar } from './Avatar'
import { Badge } from './Badges'

function Menu({
  id,
  label,
  trigger,
  children,
}: {
  id: string
  label: string
  trigger: ReactNode
  children: (close: () => void) => ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <>
      <button className="sidebar-header" popoverTarget={id} aria-label={label}>
        {trigger}
        <ChevronDown size={15} className="chevron" />
      </button>
      <div ref={ref} id={id} popover="auto" className="menu">
        {children(() => ref.current?.hidePopover())}
      </div>
    </>
  )
}
function Count({ value }: { value: number }) {
  return value ? <span className="count">{value}</span> : null
}
export function Sidebar({
  client,
  session,
  workspace,
  workspaces,
  rooms,
  channels,
  unread,
  homeCount,
  view,
  connection,
  onView,
  onRoom,
  onDialog,
  onWorkspace,
  onSecurity,
  onLogout,
  onServer,
}: {
  client: Transport
  session: Session
  workspace: Workspace
  workspaces: Workspace[]
  rooms: Room[]
  channels: Channel[]
  unread: Unread
  homeCount: number
  view: View
  connection: string
  onView: (view: View) => void
  onRoom: (roomId: RoomId) => void
  onDialog: (dialog: Dialog) => void
  onWorkspace: (workspace: Workspace) => void
  onSecurity: () => void
  onLogout: () => void
  onServer?: () => void
}) {
  const owner = workspace.role === 'owner'
  const room = view.kind === 'room' ? rooms.find((room) => room.id === view.roomId) : undefined
  const roomUnread = (roomId: RoomId) =>
    channels
      .filter((channel) => channel.roomId === roomId)
      .reduce((total, channel) => total + (unread.get(channel.id) ?? 0), 0)
  return (
    <aside className="sidebar">
      {room ? (
        <Menu
          id="room-menu"
          label={`${room.name} room`}
          trigger={
            <>
              <Badge id={room.id} name={room.name} size={26} />
              <span className="sidebar-title">
                <strong>{room.name}</strong>
                <small>
                  Room · {workspace.memberCount}{' '}
                  {workspace.memberCount === 1 ? 'member' : 'members'}
                </small>
              </span>
            </>
          }
        >
          {(close) => (
            <>
              <p className="menu-label">Rooms</p>
              {rooms.map((item) => (
                <button
                  key={item.id}
                  onClick={() => {
                    close()
                    onRoom(item.id)
                  }}
                >
                  <Badge id={item.id} name={item.name} size={20} />
                  <span>{item.name}</span>
                  {item.id === room.id && <Check size={14} className="menu-check" />}
                </button>
              ))}
              <hr />
              <button
                onClick={() => {
                  close()
                  onView({ kind: 'home' })
                }}
              >
                <House size={15} />
                <span>All rooms</span>
              </button>
            </>
          )}
        </Menu>
      ) : (
        <Menu
          id="workspace-menu"
          label={workspace.name}
          trigger={
            <>
              <Badge id={workspace.id} name={workspace.name} size={22} />
              <span className="sidebar-title">
                <strong>{workspace.name}</strong>
              </span>
            </>
          }
        >
          {(close) => {
            const act = (action: () => void) => () => {
              close()
              action()
            }
            return (
              <>
                <p className="menu-label">Workspaces</p>
                {workspaces.map((item) => (
                  <button key={item.id} onClick={act(() => onWorkspace(item))}>
                    <Badge id={item.id} name={item.name} size={20} />
                    <span>{item.name}</span>
                    {item.id === workspace.id && <Check size={14} className="menu-check" />}
                  </button>
                ))}
                <button onClick={act(() => onDialog({ kind: 'workspace', mode: 'create' }))}>
                  <Plus size={15} />
                  <span>Create a workspace</span>
                </button>
                <button onClick={act(() => onDialog({ kind: 'workspace', mode: 'join' }))}>
                  <LogIn size={15} />
                  <span>Join with an invitation</span>
                </button>
                <hr />
                {owner && (
                  <button onClick={act(() => onDialog({ kind: 'invite' }))}>
                    <UserPlus size={15} />
                    <span>Invite coworkers</span>
                  </button>
                )}
                <button onClick={act(onSecurity)}>
                  <Shield size={15} />
                  <span>Security settings</span>
                </button>
                {onServer && (
                  <button onClick={act(onServer)}>
                    <Server size={15} />
                    <span>Switch server</span>
                  </button>
                )}
                <button onClick={act(onLogout)}>
                  <LogOut size={15} />
                  <span>Sign out</span>
                </button>
              </>
            )
          }}
        </Menu>
      )}
      <nav className="sidebar-nav" aria-label={room ? `${room.name} channels` : 'Rooms'}>
        <button
          className="nav-row home-row"
          aria-current={view.kind === 'home' ? 'page' : undefined}
          onClick={() => onView({ kind: 'home' })}
        >
          <House size={16} />
          <span>Home</span>
          <Count value={homeCount} />
        </button>
        <div className="section-label">
          <span>{room ? 'Channels' : 'Rooms'}</span>
          {owner && (
            <button
              className="icon-button"
              aria-label={room ? 'Create channel' : 'Create room'}
              title={room ? 'Create channel' : 'Create room'}
              onClick={() =>
                onDialog(room ? { kind: 'channel', roomId: room.id } : { kind: 'room' })
              }
            >
              <Plus size={15} />
            </button>
          )}
        </div>
        {room
          ? channels
              .filter((channel) => channel.roomId === room.id)
              .map((channel) => {
                const count = unread.get(channel.id) ?? 0
                const current = view.kind === 'room' && view.channelId === channel.id
                return (
                  <button
                    key={channel.id}
                    className={`nav-row channel-row ${count ? 'unread' : ''}`}
                    aria-current={current ? 'page' : undefined}
                    onClick={() => onView({ kind: 'room', roomId: room.id, channelId: channel.id })}
                  >
                    <Hash size={16} />
                    <span>{channel.name}</span>
                    {count > 0 && (
                      <>
                        <i className="unread-dot" />
                        <span className="sr-only">unread</span>
                      </>
                    )}
                  </button>
                )
              })
          : rooms.map((room) => {
              const count = roomUnread(room.id)
              return (
                <button
                  key={room.id}
                  className={`nav-row room-row ${count ? 'unread' : ''}`}
                  onClick={() => onRoom(room.id)}
                >
                  <Badge id={room.id} name={room.name} />
                  <span>{room.name}</span>
                  <Count value={count} />
                </button>
              )
            })}
        {room && !channels.some((channel) => channel.roomId === room.id) && (
          <p className="sidebar-note">No channels yet.</p>
        )}
        {!room && !rooms.length && <p className="sidebar-note">No rooms yet.</p>}
      </nav>
      <footer className="account">
        <span className="account-avatar">
          <Avatar
            avatar={session.user.avatar}
            name={session.user.name}
            photo={client.photo?.bind(client)}
            size={30}
          />
          <i className={`presence ${connection === 'Connected' ? 'online' : ''}`} />
        </span>
        <span className="account-name">
          <strong>{session.user.name}</strong>
          <span role="status">{connection}</span>
        </span>
        <button
          className="icon-button"
          aria-label="Account security"
          title="Account security"
          onClick={onSecurity}
        >
          <Settings size={16} />
        </button>
      </footer>
    </aside>
  )
}
