import { Hash, MoreHorizontal } from 'lucide-react'
import type { Channel, Me } from '@huddle/contracts'
import type { Transport } from './transport'
import type { useServer } from './useServer'
import type { DirectRow } from './ServerView'
import { Avatar } from './Avatar'
import { MemberToggle } from './Members'
import { Transcript } from './Transcript'

type Shared = {
  client: Transport
  me: Me
  sync: ReturnType<typeof useServer>
  draft: string
  onDraft: (value: string) => void
}
export function ChannelConversation({
  channel,
  memberList,
  onMemberList,
  memberCount,
  onInvite,
  onSettings,
  ...shared
}: Shared & {
  channel: Channel
  memberCount: number
  onInvite?: () => void
  onSettings: () => void
  memberList: boolean
  onMemberList: () => void
}) {
  return (
    <Transcript
      {...shared}
      thread={{ kind: 'channel', id: channel.id }}
      label={`Message #${channel.name}`}
      topbar={
        <header className="topbar">
          <Hash size={18} />
          <strong>{channel.name}</strong>
          <div className="channel-actions">
            {onInvite && (
              <button className="header-pill" onClick={onInvite}>
                <span>Share invite</span>
              </button>
            )}
            <MemberToggle pressed={memberList} onToggle={onMemberList} count={memberCount} />
            <button
              className="icon-button"
              aria-label="Channel options"
              popoverTarget="channel-menu"
            >
              <MoreHorizontal size={18} />
            </button>
          </div>
          <div id="channel-menu" popover="auto" className="menu channel-menu">
            <button
              onClick={(event) => {
                event.currentTarget.parentElement?.hidePopover()
                onSettings()
              }}
            >
              Settings
            </button>
          </div>
        </header>
      }
      welcome={
        <>
          <h1 aria-label={`Welcome to #${channel.name}`}>A place for the everyday.</h1>
          <p>Plans, little updates, and whatever’s on your mind.</p>
        </>
      }
    />
  )
}
export function DirectConversation({
  direct,
  onSettings,
  ...shared
}: Shared & { direct: DirectRow; onSettings: () => void }) {
  const { name, avatar } = direct.peer
  const [firstName = name] = name.split(/\s+/)
  const photo = shared.client.photo?.bind(shared.client)
  return (
    <Transcript
      {...shared}
      thread={{ kind: 'direct', id: direct.id }}
      label={`Message @${name}`}
      placeholder={`Message ${firstName}`}
      topbar={
        <header className="topbar direct-topbar">
          <i className="avatar-slot" aria-hidden="true">
            <Avatar avatar={avatar} name={name} photo={photo} size={32} />
          </i>
          <div className="direct-person">
            <strong>{name}</strong>
            <span>Direct message</span>
          </div>
          <button
            className="icon-button direct-details-trigger"
            aria-label="Conversation details"
            title="Conversation details"
            popoverTarget="direct-details"
          >
            <MoreHorizontal size={18} />
          </button>
          <section
            id="direct-details"
            popover="auto"
            className="direct-details"
            aria-labelledby="direct-details-title"
          >
            <h2 id="direct-details-title">Conversation details</h2>
            <p>Messages are stored on this server unencrypted, so its host could read them.</p>
            <button
              className="button small"
              onClick={(event) => {
                event.currentTarget.parentElement?.hidePopover()
                onSettings()
              }}
            >
              Settings
            </button>
          </section>
        </header>
      }
      welcome={
        <>
          <h1 aria-label={`Conversation with ${name}`}>Just the two of you.</h1>
          <p>This is your conversation with {firstName}.</p>
        </>
      }
    />
  )
}
