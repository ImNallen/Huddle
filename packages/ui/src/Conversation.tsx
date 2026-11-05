import { Hash } from 'lucide-react'
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
  ...shared
}: Shared & {
  channel: Channel
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
          <Hash size={20} />
          <strong>{channel.name}</strong>
          <MemberToggle pressed={memberList} onToggle={onMemberList} />
        </header>
      }
      welcome={
        <>
          <span className="empty-mark">
            <Hash size={40} />
          </span>
          <h1>Welcome to #{channel.name}</h1>
          <p>This is the start of #{channel.name}.</p>
        </>
      }
    />
  )
}
export function DirectConversation({ direct, ...shared }: Shared & { direct: DirectRow }) {
  const { name, avatar } = direct.peer
  const photo = shared.client.photo?.bind(shared.client)
  return (
    <Transcript
      {...shared}
      thread={{ kind: 'direct', id: direct.id }}
      label={`Message @${name}`}
      topbar={
        <header className="topbar">
          <i className="avatar-slot" aria-hidden="true">
            <Avatar avatar={avatar} name={name} photo={photo} size={24} />
          </i>
          <strong>{name}</strong>
        </header>
      }
      welcome={
        <>
          <i className="avatar-slot welcome-avatar" aria-hidden="true">
            <Avatar avatar={avatar} name={name} photo={photo} size={68} />
          </i>
          <h1>{name}</h1>
          <p>This is the start of your conversation with {name}.</p>
          <p className="welcome-note">
            Messages are stored on this server unencrypted, so its host could read them.
          </p>
        </>
      }
    />
  )
}
