import { Hash, Plus } from 'lucide-react'
import type { Room } from '@huddle/contracts'
import type { Dialog } from './ServerView'
import { MemberToggle } from './Members'

export function EmptyRoom({
  room,
  admin,
  onDialog,
  memberList,
  onMemberList,
}: {
  room: Room
  admin: boolean
  onDialog: (dialog: Dialog) => void
  memberList: boolean
  onMemberList: () => void
}) {
  return (
    <main className="main">
      <header className="topbar">
        <strong>{room.name}</strong>
        <MemberToggle pressed={memberList} onToggle={onMemberList} />
      </header>
      <div className="center-state">
        <span className="empty-mark">
          <Hash size={40} />
        </span>
        <h1>{room.name} has no channels yet</h1>
        <p>
          {admin
            ? 'Channels hold the conversation inside a room. Start with one.'
            : 'An admin can create the first channel.'}
        </p>
        {admin && (
          <button
            className="button primary"
            onClick={() => onDialog({ kind: 'channel', roomId: room.id, channelKind: 'text' })}
          >
            <Plus size={16} />
            Create a channel
          </button>
        )}
      </div>
    </main>
  )
}
