import { Mic, MicOff, PhoneOff, Volume2, X } from 'lucide-react'
import type { Avatar as AvatarValue, Channel, Me, Member } from '@huddle/contracts'
import type { Transport } from './transport'
import type { Call, VoiceCall } from './voiceCall'
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
  return (
    <main className="main">
      <header className="topbar">
        <Volume2 size={20} />
        <strong>{channel.name}</strong>
        <MemberToggle pressed={memberList} onToggle={onMemberList} />
      </header>
      <div className="center-state">
        {!inCall && (
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
              muted={inCall.muted}
            />
            {inCall.people.map((person) => (
              <CallPersonTile
                key={person.id}
                client={client}
                name={roster?.find((member) => member.id === person.id)?.name ?? person.name}
                avatar={roster?.find((member) => member.id === person.id)?.avatar}
                muted={person.muted}
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

const panelStatus: Record<Exclude<Call['phase'], 'idle'>, string> = {
  'requesting-mic': 'Waiting for microphone',
  connecting: 'Joining',
  connected: 'Voice connected',
  reconnecting: 'Reconnecting',
  failed: 'Call ended',
}
/** Holds the call's controls wherever the person goes, like the account panel below it. */
export function CallPanel({
  voice,
  channels,
  viewing,
  onOpen,
}: {
  voice: VoiceCall
  channels: Channel[]
  viewing: Channel['id'] | null
  onOpen: (channel: Channel) => void
}) {
  const { call } = voice
  if (call.phase === 'idle' || (call.phase === 'failed' && call.channelId === viewing)) return null
  const channel = channels.find((item) => item.id === call.channelId)
  const inCall = call.phase === 'connected' || call.phase === 'reconnecting' ? call : null
  return (
    <section className="call-panel" aria-label="Call">
      <div className="call-panel-row">
        <button
          className="call-place"
          title={channel && `Open ${channel.name}`}
          onClick={() => channel && onOpen(channel)}
        >
          <strong className={`call-status ${call.phase}`} role="status">
            {call.phase === 'failed' ? call.title : panelStatus[call.phase]}
          </strong>
          <span>{channel?.name ?? 'Voice channel'}</span>
        </button>
        {inCall && (
          <button
            className="icon-button call-mute"
            aria-label="Mute"
            title={inCall.muted ? 'Unmute' : 'Mute'}
            aria-pressed={inCall.muted}
            onClick={() => voice.setMuted(!inCall.muted)}
          >
            {inCall.muted ? <MicOff size={18} /> : <Mic size={18} />}
          </button>
        )}
        {call.phase === 'failed' ? (
          <button
            className="icon-button"
            aria-label="Dismiss"
            title="Dismiss"
            onClick={voice.leave}
          >
            <X size={18} />
          </button>
        ) : (
          <button
            className="icon-button"
            aria-label={inCall ? 'Leave call' : 'Cancel'}
            title={inCall ? 'Leave call' : 'Cancel'}
            onClick={voice.leave}
          >
            <PhoneOff size={18} />
          </button>
        )}
      </div>
      {inCall?.soundBlocked && (
        <button className="button small primary call-sound" onClick={voice.startSound}>
          Turn on sound
        </button>
      )}
    </section>
  )
}
