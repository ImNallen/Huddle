import { HeadphoneOff, Headphones, Mic, MicOff, PhoneOff, Volume2, X } from 'lucide-react'
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
import { BackButton, ChannelMenu, type ChannelActions } from './Conversation'
import { Spinner } from './primitives'

export type VoiceAvailability = 'on' | 'off'

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
  roomName,
  channels,
  availability,
  voice,
  present,
  roster,
  memberList,
  onMemberList,
  onSettings,
  onBack,
  admin,
}: {
  client: Transport
  me: Me
  channel: Channel
  roomName: string
  channels: Channel[]
  availability: VoiceAvailability
  voice: VoiceCall
  present: VoicePresence[number]['people']
  roster: Member[] | null
  memberList: boolean
  onMemberList: () => void
  onSettings: () => void
  onBack: () => void
  admin?: ChannelActions
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
        <BackButton onBack={onBack} />
        <Volume2 size={20} />
        <strong>{channel.name}</strong>
        <span className="topbar-subtitle">{roomName} · Voice</span>
        <div className="channel-actions">
          <MemberToggle pressed={memberList} onToggle={onMemberList} />
          <ChannelMenu channel={channel} admin={admin} onSettings={onSettings} />
        </div>
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
        ) : here?.phase === 'requesting-mic' ? (
          <p>
            {document.documentElement.dataset.native
              ? 'Waiting for your microphone. Allow Huddle to use it if asked.'
              : 'Waiting for your microphone. Allow it if your browser asks.'}
          </p>
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
        {inCall && <CallControls voice={voice} status={callStatus(inCall)} />}
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
const liveCall = (call: Call) =>
  call.phase === 'connected' || call.phase === 'reconnecting' ? call : null
function audioChoice(voice: VoiceCall) {
  const audio = liveCall(voice.call)?.audio ?? voice.audio
  return { muted: microphoneMuted(audio), deafened: audio.kind === 'deafened' }
}

/** The full-screen call's thumb-sized controls, shown only below 640px where the profile bar is gone. */
function CallControls({ voice, status }: { voice: VoiceCall; status: string }) {
  const { muted, deafened } = audioChoice(voice)
  return (
    <>
      <p className="call-chip">
        <Headphones size={16} aria-hidden="true" />
        {status}
      </p>
      <div className="call-controls">
        <button
          className="call-control"
          aria-pressed={muted}
          disabled={deafened}
          onClick={() => voice.setMuted(!muted)}
        >
          <span className="call-control-icon">
            {muted ? <MicOff size={24} aria-hidden="true" /> : <Mic size={24} aria-hidden="true" />}
          </span>
          Mute
        </button>
        <button
          className="call-control"
          aria-pressed={deafened}
          onClick={() => voice.setDeafened(!deafened)}
        >
          <span className="call-control-icon">
            {deafened ? (
              <HeadphoneOff size={24} aria-hidden="true" />
            ) : (
              <Headphones size={24} aria-hidden="true" />
            )}
          </span>
          Deafen
        </button>
        <button className="call-control call-control-leave" onClick={voice.leave}>
          <span className="call-control-icon">
            <PhoneOff size={24} aria-hidden="true" />
          </span>
          Leave
        </button>
      </div>
    </>
  )
}

/** Stands in for the profile bar's call strip on a narrow window's pushed screens. */
export function CallPill({
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
  if (call.phase === 'idle' || call.channelId === viewing) return null
  const channel = channels.find((item) => item.id === call.channelId)
  const inCall = liveCall(call)
  const { muted, deafened } = audioChoice(voice)
  const detail = inCall
    ? ['You', ...inCall.people.map(({ name }) => name.split(/\s+/)[0] ?? name)].join(', ')
    : callStatus(call)
  return (
    <div className="call-pill">
      <button
        className="call-pill-place"
        aria-label={channel ? `Open ${channel.name}` : 'Open voice channel'}
        disabled={!channel}
        onClick={() => channel && onOpen(channel)}
      >
        <Volume2 size={16} aria-hidden="true" />
        <span>
          {channel?.name ?? 'Voice channel'} · {detail}
        </span>
      </button>
      {inCall && (
        <button
          className="call-pill-mute"
          aria-label="Mute"
          aria-pressed={muted}
          disabled={deafened}
          onClick={() => voice.setMuted(!muted)}
        >
          {muted ? <MicOff size={16} aria-hidden="true" /> : <Mic size={16} aria-hidden="true" />}
        </button>
      )}
    </div>
  )
}

/** Shows the call wherever the person goes, above their name in the profile bar. */
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
  const inCall = liveCall(call)
  const muted = inCall ? microphoneMuted(inCall.audio) : false
  const finish = inCall ? 'Leave call' : call.phase === 'failed' ? 'Dismiss' : 'Cancel'
  return (
    <section className="call-panel" aria-label="Call">
      <div className="call-row">
        <button
          className="call-place"
          aria-label={channel ? `Open ${channel.name}` : 'Open voice channel'}
          disabled={!channel}
          onClick={() => channel && onOpen(channel)}
        >
          <span className="call-summary">
            <strong
              className={`call-status ${call.phase}${muted ? ' is-muted' : ''}`}
              role="status"
            >
              {callStatus(call)}
            </strong>
            <span className="call-location">
              {channel?.name ?? 'Voice channel'}
              {room && ` · ${room.name}`}
            </span>
          </span>
        </button>
        <button
          className={`bar-control${inCall ? ' call-leave' : ''}`}
          aria-label={finish}
          data-tooltip={finish}
          onClick={voice.leave}
        >
          {inCall ? <PhoneOff size={18} aria-hidden="true" /> : <X size={18} aria-hidden="true" />}
        </button>
      </div>
      {inCall?.soundBlocked && inCall.audio.kind !== 'deafened' && (
        <button className="button small primary call-sound" onClick={voice.startSound}>
          Turn on sound
        </button>
      )}
    </section>
  )
}

/** Mute and Deafen work with or without a call, so the next call starts the way the person chose. */
export function AudioControls({ voice }: { voice: VoiceCall }) {
  const { muted, deafened } = audioChoice(voice)
  return (
    <>
      <button
        className="bar-control"
        aria-label="Mute"
        data-tooltip={deafened ? 'Undeafen to unmute' : muted ? 'Unmute' : 'Mute'}
        aria-pressed={muted}
        disabled={deafened}
        onClick={() => voice.setMuted(!muted)}
      >
        {muted ? <MicOff size={18} aria-hidden="true" /> : <Mic size={18} aria-hidden="true" />}
      </button>
      <button
        className="bar-control"
        aria-label="Deafen"
        data-tooltip={deafened ? 'Undeafen' : 'Deafen'}
        aria-pressed={deafened}
        onClick={() => voice.setDeafened(!deafened)}
      >
        {deafened ? (
          <HeadphoneOff size={18} aria-hidden="true" />
        ) : (
          <Headphones size={18} aria-hidden="true" />
        )}
      </button>
    </>
  )
}
