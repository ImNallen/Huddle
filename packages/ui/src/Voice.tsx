import { Headphones, Mic, MicOff, PhoneOff, Volume2 } from 'lucide-react'
import type {
  Avatar as AvatarValue,
  Channel,
  Me,
  Member,
  Room,
  VoicePresence,
} from '@huddle/contracts'
import type { Transport } from './transport'
import { microphoneMuted, type Call, type VoiceCall } from './voiceCall'
import { Avatar } from './Avatar'
import { MemberToggle } from './Members'
import { Spinner } from './primitives'

/** The desktop app cannot make calls yet: macOS needs a microphone permission it does not ask for. */
export type VoiceAvailability = 'on' | 'off' | 'desktop'

function CallPersonTile({
  client,
  name,
  avatar,
  muted,
}: {
  client: Transport
  name: string
  avatar: AvatarValue | null | undefined
  muted: boolean
}) {
  return (
    <li className="call-person">
      <span className="call-person-avatar">
        <Avatar avatar={avatar} name={name} photo={client.photo?.bind(client)} size={56} />
        {muted && (
          <i className="call-person-muted">
            <MicOff size={12} aria-hidden="true" />
            <span className="sr-only">muted</span>
          </i>
        )}
      </span>
      <span className="call-person-name" title={name}>
        {name}
      </span>
    </li>
  )
}
function peopleLine(count: number) {
  return count === 0 ? "You're the only one here." : `${count + 1} people in this call.`
}
export function VoiceChannel({
  client,
  me,
  channel,
  channels,
  availability,
  voice,
  present,
  roster,
  memberList,
  onMemberList,
}: {
  client: Transport
  me: Me
  channel: Channel
  channels: Channel[]
  availability: VoiceAvailability
  voice: VoiceCall
  present: VoicePresence[number]['people']
  roster: Member[] | null
  memberList: boolean
  onMemberList: () => void
}) {
  const { call } = voice
  const here = call.phase !== 'idle' && call.channelId === channel.id ? call : null
  const elsewhere =
    call.phase !== 'idle' && call.phase !== 'failed' && !here
      ? channels.find((item) => item.id === call.channelId)
      : undefined
  const inCall = here?.phase === 'connected' || here?.phase === 'reconnecting' ? here : null
  const joining = here?.phase === 'requesting-mic' || here?.phase === 'connecting'
  const failed = here?.phase === 'failed' ? here : null
  const watching = !inCall && availability !== 'off' ? present : []
  const nameOf = (person: { id: string; name: string }) =>
    roster?.find((member) => member.id === person.id)?.name ?? person.name
  const avatarOf = (person: { id: string }) =>
    roster?.find((member) => member.id === person.id)?.avatar
  return (
    <main className="main">
      <header className="topbar">
        <Volume2 size={20} />
        <strong>{channel.name}</strong>
        <MemberToggle pressed={memberList} onToggle={onMemberList} />
      </header>
      <div className="center-state">
        {!inCall && (joining || !watching.length) && (
          <span className="empty-mark">
            {joining ? <Spinner size={24} /> : <Volume2 size={40} />}
          </span>
        )}
        <h1>{channel.name}</h1>
        {availability === 'off' ? (
          <p>Voice is turned off on this server. Text channels work as usual.</p>
        ) : availability === 'desktop' ? (
          <p>Calls don't work in the desktop app yet. Open this server in a browser to join.</p>
        ) : here?.phase === 'requesting-mic' ? (
          <p>Waiting for your microphone. Allow it if your browser asks.</p>
        ) : here?.phase === 'connecting' ? (
          <p>Joining the call.</p>
        ) : inCall ? (
          <p>
            {inCall.phase === 'reconnecting' ? 'Reconnecting.' : peopleLine(inCall.people.length)}
          </p>
        ) : failed ? (
          <p role="alert" className="call-problem">
            {failed.message}
          </p>
        ) : elsewhere ? (
          <p>Joining here takes you out of {elsewhere.name}.</p>
        ) : (
          <p>Nobody hears you until you join.</p>
        )}
        {inCall && (
          <ul className="call-people" aria-label="In this call">
            <CallPersonTile
              client={client}
              name={me.user.name}
              avatar={me.user.avatar}
              muted={microphoneMuted(inCall.audio)}
            />
            {inCall.people.map((person) => (
              <CallPersonTile
                key={person.id}
                client={client}
                name={nameOf(person)}
                avatar={avatarOf(person)}
                muted={person.muted}
              />
            ))}
          </ul>
        )}
        {watching.length > 0 && (
          <ul className="call-people" aria-label="In this call">
            {watching.map((person) => (
              <CallPersonTile
                key={person.id}
                client={client}
                name={nameOf(person)}
                avatar={avatarOf(person)}
                muted={false}
              />
            ))}
          </ul>
        )}
        {availability === 'on' &&
          (inCall || joining ? (
            <button className="button" onClick={voice.leave}>
              {inCall ? 'Leave call' : 'Cancel'}
            </button>
          ) : (
            <button className="button primary" onClick={() => voice.join(channel.id)}>
              {failed ? 'Try again' : 'Join voice'}
            </button>
          ))}
      </div>
    </main>
  )
}

function callStatus(call: Exclude<Call, { phase: 'idle' }>): string {
  switch (call.phase) {
    case 'requesting-mic':
      return 'Waiting for microphone'
    case 'connecting':
      return 'Joining the call…'
    case 'failed':
      return call.title
    case 'reconnecting':
      return call.audio.kind === 'deafened'
        ? 'Reconnecting · deafened'
        : microphoneMuted(call.audio)
          ? 'Reconnecting · muted'
          : 'Reconnecting…'
    case 'connected':
      return call.audio.kind === 'deafened'
        ? 'Deafened'
        : microphoneMuted(call.audio)
          ? 'Microphone muted'
          : 'Voice connected'
  }
}
/** Holds the call's controls wherever the person goes, like the account panel below it. */
export function CallPanel({
  voice,
  channels,
  rooms,
  viewing,
  onOpen,
}: {
  voice: VoiceCall
  channels: Channel[]
  rooms: Room[]
  viewing: Channel['id'] | null
  onOpen: (channel: Channel) => void
}) {
  const { call } = voice
  if (call.phase === 'idle' || (call.phase === 'failed' && call.channelId === viewing)) return null
  const channel = channels.find((item) => item.id === call.channelId)
  const room = rooms.find((item) => item.id === channel?.roomId)
  const inCall = call.phase === 'connected' || call.phase === 'reconnecting' ? call : null
  const muted = inCall ? microphoneMuted(inCall.audio) : false
  const deafened = inCall?.audio.kind === 'deafened'
  return (
    <section className="call-panel" aria-label="Call">
      <button
        className="call-place"
        aria-label={channel ? `Open ${channel.name}` : 'Open voice channel'}
        disabled={!channel}
        onClick={() => channel && onOpen(channel)}
      >
        <span className="call-summary">
          <strong className={`call-status ${call.phase}${muted ? ' is-muted' : ''}`} role="status">
            {callStatus(call)}
          </strong>
          <span className="call-location">
            {channel?.name ?? 'Voice channel'}
            {room && ` · ${room.name}`}
          </span>
        </span>
        <span className="call-open">Open</span>
      </button>
      {inCall ? (
        <div className="call-controls">
          <button
            className="call-control call-mute"
            aria-label="Mute"
            data-tooltip={deafened ? 'Undeafen to unmute' : muted ? 'Unmute' : 'Mute'}
            aria-pressed={muted}
            disabled={deafened}
            onClick={() => voice.setMuted(!muted)}
          >
            <Mic size={18} aria-hidden="true" />
            <span>{muted ? 'Unmute' : 'Mute'}</span>
          </button>
          <button
            className="call-control"
            aria-label="Deafen"
            data-tooltip={deafened ? 'Undeafen' : 'Deafen'}
            aria-pressed={deafened}
            onClick={() => voice.setDeafened(!deafened)}
          >
            <Headphones size={18} aria-hidden="true" />
            <span>{deafened ? 'Undeafen' : 'Deafen'}</span>
          </button>
          <button
            className="call-control call-leave"
            aria-label="Leave call"
            data-tooltip="Leave call"
            onClick={voice.leave}
          >
            <PhoneOff size={18} aria-hidden="true" />
            <span>Leave</span>
          </button>
        </div>
      ) : (
        <button className="button small call-finish" onClick={voice.leave}>
          {call.phase === 'failed' ? 'Dismiss' : 'Cancel'}
        </button>
      )}
      {inCall?.soundBlocked && !deafened && (
        <button className="button small primary call-sound" onClick={voice.startSound}>
          Turn on sound
        </button>
      )}
    </section>
  )
}
