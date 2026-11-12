import { Popover } from './Popover'
import { Hash, MoreHorizontal } from 'lucide-react'
import type { Channel, Me } from '@huddle/contracts'
import type { Transport } from './transport'
import { channelLabel, type useServer } from './useServer'
import type { DirectRow } from './ServerView'
import { Avatar } from './Avatar'
import { MemberToggle } from './Members'
import { Transcript } from './Transcript'

type Shared = {
  client: Transport
  me: Me
  sync: ReturnType<typeof useServer>
}
export type ChannelActions = { onRename: () => void; onDelete: () => void }
export function ChannelMenu({
  channel,
  admin,
  onSettings,
}: {
  channel: Channel
  admin?: ChannelActions
  onSettings: () => void
}) {
  return (
    <>
      <button
        className="icon-button"
        aria-label="Channel options"
        data-tooltip="Channel options"
        popoverTarget="channel-menu"
      >
        <MoreHorizontal size={18} />
      </button>
      <Popover id="channel-menu" label="Channel actions" menu>
        <p className="menu-context">{channelLabel(channel)}</p>
        {admin && (
          <>
            <button type="button" onClick={admin.onRename}>
              Rename channel…
            </button>
            <button type="button" className="menu-danger" onClick={admin.onDelete}>
              Delete channel…
            </button>
            <hr />
          </>
        )}
        <button type="button" onClick={onSettings}>
          Settings
        </button>
      </Popover>
    </>
  )
}
export function ChannelConversation({
  channel,
  memberList,
  onMemberList,
  memberCount,
  onInvite,
  onSettings,
  admin,
  ...shared
}: Shared & {
  channel: Channel
  memberCount: number
  onInvite?: () => void
  onSettings: () => void
  admin?: ChannelActions
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
            <ChannelMenu channel={channel} admin={admin} onSettings={onSettings} />
          </div>
        </header>
      }
      welcome={
        <>
          <h1 aria-label={`Welcome to #${channel.name}`}>A place for the everyday.</h1>
          <p>Plans, little updates, and whatever’s on your mind.</p>
        </>
      }
      emptyWelcome={
        <>
          <h1 aria-label={`Welcome to #${channel.name}`}>The start of #{channel.name}</h1>
          <p>No messages yet. Say hello when you’re ready.</p>
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
      closed={
        direct.peer.former
          ? `${name} is no longer on this server. You can still read your conversation.`
          : undefined
      }
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
            data-tooltip="Conversation details"
            popoverTarget="direct-details"
          >
            <MoreHorizontal size={18} />
          </button>
          <Popover
            id="direct-details"
            role="region"
            label="Conversation details"
            className="direct-details"
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
          </Popover>
        </header>
      }
      welcome={
        <>
          <h1 aria-label={`Conversation with ${name}`}>Just the two of you.</h1>
          <p>This is your conversation with {firstName}.</p>
        </>
      }
      emptyWelcome={
        <div className="empty-conversation">
          <Avatar avatar={avatar} name={name} photo={photo} size={52} />
          <h1 aria-label={`Conversation with ${name}`}>Say hello to {firstName}.</h1>
          <p>This is the start of your conversation with {firstName}.</p>
        </div>
      }
    />
  )
}
