import { useEffect, useRef, useState } from 'react'
import { VoiceGrant, type ChannelId } from '@huddle/contracts'
import type { LocalAudioTrack, RemoteAudioTrack, Room } from 'livekit-client'
import { errorText, type Transport } from './transport'

export type CallAudio =
  | { kind: 'listening'; muted: boolean }
  | { kind: 'deafened'; restoreMuted: boolean }

export const microphoneMuted = (audio: CallAudio) => audio.kind === 'deafened' || audio.muted

export type CallPerson = { id: string; name: string; muted: boolean }
export type Call =
  | { phase: 'idle' }
  | { phase: 'requesting-mic' | 'connecting'; channelId: ChannelId }
  | {
      phase: 'connected' | 'reconnecting'
      channelId: ChannelId
      people: CallPerson[]
      audio: CallAudio
      soundBlocked: boolean
    }
  | { phase: 'failed'; channelId: ChannelId; title: string; message: string }

type Session = {
  leave: () => void
  setAudio: (audio: CallAudio) => void
  startSound: () => void
}
type LiveKit = typeof import('livekit-client')

function microphoneProblem(lk: LiveKit, error: unknown) {
  switch (lk.MediaDeviceFailure.getFailure(error)) {
    case lk.MediaDeviceFailure.PermissionDenied:
      return document.documentElement.dataset.native
        ? "Huddle can't use your microphone. Allow Huddle in your system's microphone privacy settings, then quit and reopen Huddle."
        : "Huddle can't use your microphone. Allow it in your browser's settings for this site, then try again."
    case lk.MediaDeviceFailure.NotFound:
      return "Huddle can't find a microphone. Connect one, then try again."
    case lk.MediaDeviceFailure.DeviceInUse:
      return "Your microphone isn't responding. Another app may be using it. Close that app, then try again."
    default:
      return "Your microphone didn't start. Try again."
  }
}
function connectionProblem(lk: LiveKit, error: unknown, url: URL, reachedService: boolean) {
  if (reachedService)
    return 'Huddle reached the voice service, but audio could not get through. Ask whoever hosts this server to allow UDP port 7882 for you.'
  if (error instanceof lk.ConnectionError && error.reason === lk.ConnectionErrorReason.NotAllowed)
    return 'The voice service turned this call down. Ask whoever hosts this server to check its LiveKit secret.'
  const port = url.port || (url.protocol === 'wss:' ? '443' : '80')
  return `Huddle couldn't reach the voice service at ${url.host}. Check that Tailscale is connected. If it is, ask whoever hosts this server to allow TCP port ${port} for you.`
}
function endedMessage(lk: LiveKit, reason: number | undefined) {
  switch (reason) {
    case lk.DisconnectReason.DUPLICATE_IDENTITY:
      return 'You joined this call from somewhere else, so it ended here.'
    case lk.DisconnectReason.PARTICIPANT_REMOVED:
      return "Huddle ended this call because it couldn't confirm your access. Check that Tailscale is connected, then try again."
    case lk.DisconnectReason.ROOM_DELETED:
    case lk.DisconnectReason.ROOM_CLOSED:
      return 'This call was closed.'
    default:
      return 'The connection to this call was lost.'
  }
}

/** Runs one attempt at one call. Everything it acquires is released on every path, so a person's
 *  microphone never stays open behind a call the interface says is over. */
function startCall(
  client: Transport,
  channelId: ChannelId,
  initialAudio: CallAudio,
  onChange: (call: Call) => void,
): Session {
  let over = false
  let inCall = false
  let room: Room | null = null
  let microphone: LocalAudioTrack | null = null
  const sounds = new Map<HTMLMediaElement, RemoteAudioTrack>()
  let audio = initialAudio
  let changingAudio = false
  let audioChanges = Promise.resolve()

  function release() {
    over = true
    microphone?.stop()
    void room?.disconnect()
    for (const sound of sounds.keys()) sound.remove()
    sounds.clear()
  }
  function fail(title: string, message: string) {
    if (over) return
    release()
    onChange({ phase: 'failed', channelId, title, message })
  }
  const joinFailed = (message: string) => fail("Couldn't join", message)
  function report() {
    if (over || changingAudio || !inCall || !room || !microphone) return
    const { state } = room
    if (state === 'disconnected') return
    onChange({
      phase: state === 'connected' ? 'connected' : 'reconnecting',
      channelId,
      people: [...room.remoteParticipants.values()].map((person) => ({
        id: person.identity,
        name: person.name || 'Friend',
        muted: !person.isMicrophoneEnabled,
      })),
      audio: audio.kind === 'deafened' ? audio : { kind: 'listening', muted: microphone.isMuted },
      soundBlocked: !room.canPlaybackAudio,
    })
  }
  async function begin() {
    onChange({ phase: 'requesting-mic', channelId })
    if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection)
      return joinFailed(
        document.documentElement.dataset.native
          ? "Huddle can't make calls on this system. Open this server in Chrome, Edge, or Safari."
          : "This browser can't make calls. Open Huddle in Chrome, Edge, or Safari.",
      )
    let lk: LiveKit
    try {
      lk = await import('livekit-client')
    } catch {
      return joinFailed("Huddle couldn't load what it needs for calls. Reload this page.")
    }
    if (over) return
    let grabbed: LocalAudioTrack
    try {
      grabbed = await lk.createLocalAudioTrack()
    } catch (error) {
      return joinFailed(microphoneProblem(lk, error))
    }
    // A cancelled attempt still receives the microphone if the person answers the prompt afterwards.
    if (over) return void grabbed.stop()
    microphone = grabbed
    onChange({ phase: 'connecting', channelId })

    const grant = await client
      .request('/api/voice/token', VoiceGrant, { channelId })
      .catch((error: unknown) => joinFailed(errorText(error)))
    if (over || !grant) return

    const joining = new lk.Room()
    room = joining
    let reachedService = false
    joining
      .on(lk.RoomEvent.SignalConnected, () => (reachedService = true))
      .on(lk.RoomEvent.TrackSubscribed, (track) => {
        if (!(track instanceof lk.RemoteAudioTrack) || over) return
        const volume = audio.kind === 'deafened' ? 0 : 1
        track.setVolume(volume)
        const sound = document.createElement('audio')
        sound.volume = volume
        track.attach(sound)
        sounds.set(sound, track)
        document.body.append(sound)
      })
      .on(lk.RoomEvent.TrackUnsubscribed, (track) => {
        for (const sound of track.detach()) {
          sound.remove()
          sounds.delete(sound)
        }
      })
      .on(lk.RoomEvent.ParticipantConnected, report)
      .on(lk.RoomEvent.ParticipantDisconnected, report)
      .on(lk.RoomEvent.ParticipantNameChanged, report)
      .on(lk.RoomEvent.TrackPublished, report)
      .on(lk.RoomEvent.TrackUnpublished, report)
      .on(lk.RoomEvent.TrackMuted, report)
      .on(lk.RoomEvent.TrackUnmuted, report)
      .on(lk.RoomEvent.ConnectionStateChanged, report)
      .on(lk.RoomEvent.AudioPlaybackStatusChanged, report)
      .on(lk.RoomEvent.Disconnected, (reason) => {
        if (inCall || reason === lk.DisconnectReason.PARTICIPANT_REMOVED)
          fail('Call ended', endedMessage(lk, reason))
      })
    const url = new URL(grant.url)
    try {
      await joining.connect(grant.url, grant.token)
      if (over) return
      if (microphoneMuted(audio)) await grabbed.mute()
      await joining.localParticipant.publishTrack(grabbed)
    } catch (error) {
      return joinFailed(connectionProblem(lk, error, url, reachedService))
    }
    if (over) return
    inCall = true
    report()
  }
  void begin().catch((error: unknown) => joinFailed(errorText(error)))

  return {
    leave: release,
    setAudio(next) {
      audioChanges = audioChanges
        .then(async () => {
          if (over || !microphone) return
          changingAudio = true
          if (microphoneMuted(next)) await microphone.mute()
          if (over) return void microphone.stop()
          audio = next
          for (const track of sounds.values()) track.setVolume(next.kind === 'deafened' ? 0 : 1)
          if (!microphoneMuted(next)) await microphone.unmute()
          if (over) return void microphone.stop()
          changingAudio = false
          report()
        })
        .catch(() => {
          changingAudio = false
          fail('Call ended', 'Your microphone stopped working.')
        })
    },
    startSound() {
      room?.startAudio().then(report, report)
    },
  }
}

export function useVoiceCall(client: Transport) {
  const [call, setCall] = useState<Call>({ phase: 'idle' })
  const session = useRef<Session | null>(null)
  const audio = useRef<CallAudio>({ kind: 'listening', muted: false })
  useEffect(
    () => () => {
      session.current?.leave()
      session.current = null
    },
    [],
  )
  return {
    call,
    /** Joins a channel, leaving any call already open and preserving the person's audio choices. */
    join(channelId: ChannelId) {
      session.current?.leave()
      session.current = startCall(client, channelId, audio.current, setCall)
    },
    leave() {
      session.current?.leave()
      session.current = null
      setCall({ phase: 'idle' })
    },
    setMuted(next: boolean) {
      if (audio.current.kind === 'deafened') return
      audio.current = { kind: 'listening', muted: next }
      session.current?.setAudio(audio.current)
    },
    setDeafened(next: boolean) {
      if (next && audio.current.kind === 'listening') {
        audio.current = { kind: 'deafened', restoreMuted: audio.current.muted }
      } else if (!next && audio.current.kind === 'deafened') {
        audio.current = { kind: 'listening', muted: audio.current.restoreMuted }
      }
      session.current?.setAudio(audio.current)
    },
    startSound: () => session.current?.startSound(),
  }
}
export type VoiceCall = ReturnType<typeof useVoiceCall>
