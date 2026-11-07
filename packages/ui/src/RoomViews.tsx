import { Hash } from 'lucide-react'
import type { Room } from '@huddle/contracts'
import type { Dialog } from './ServerView'
import { MemberToggle } from './Members'

export function EmptyRoom({
  room,
  admin,
  onDialog,
  memberList,
  memberCount,
  onMemberList,
}: {
  room: Room
  admin: boolean
  onDialog: (dialog: Dialog) => void
  memberList: boolean
  memberCount: number
  onMemberList: () => void
}) {
  return (
    <main className="main">
      <header className="topbar">
        <strong>{room.name}</strong>
        <div className="channel-actions">
          {admin && (
            <button className="header-pill" onClick={() => onDialog({ kind: 'invite' })}>
              Share invite
            </button>
          )}
          <MemberToggle pressed={memberList} onToggle={onMemberList} count={memberCount} />
        </div>
      </header>
      <div className="center-state">
        <span className="empty-mark">
          <Hash size={32} />
        </span>
        <h1 aria-label={`${room.name} has no channels yet`}>
          {room.name} is ready for a conversation.
        </h1>
        <p>
          {admin
            ? 'Create a channel to give everyone a place to start.'
            : 'An admin can create the first channel.'}
        </p>
        {admin && (
          <button
            className="button primary"
            onClick={() => onDialog({ kind: 'channel', roomId: room.id, channelKind: 'text' })}
          >
            Create a channel
          </button>
        )}
      </div>
    </main>
  )
}
