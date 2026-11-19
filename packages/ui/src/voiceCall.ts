import { useEffect, useRef, useState } from 'react'
import {
  VoiceGrant,
  DirectCall,
  type CallId,
  type ConversationId,
  type ChannelId,
} from '@huddle/contracts'
import type {
  AudioProcessorOptions,
  LocalAudioTrack,
  RemoteAudioTrack,
  Room,
  Track,
  TrackProcessor,
} from 'livekit-client'
import { errorText, type Transport } from './transport'
import {
  presentDevice,
  sinkSupported,
  subscribeVoiceSettings,
  voiceSettings,
} from './voiceSettings'

export type CallAudio =
  | { kind: 'listening'; muted: boolean }
  | { kind: 'deafened'; restoreMuted: boolean }

export const microphoneMuted = (audio: CallAudio) => audio.kind === 'deafened' || audio.muted

export type CallPerson = { id: string; name: string; muted: boolean }
export type CallTarget =
  | { kind: 'channel'; channelId: ChannelId }
  | { kind: 'direct'; callId: CallId; conversationId: ConversationId; name: string }

export type Call =
  | { phase: 'idle' }
  | { phase: 'requesting-mic' | 'connecting'; target: CallTarget }
  | {
      phase: 'connected' | 'reconnecting'
      target: CallTarget
      people: CallPerson[]
      audio: CallAudio
      soundBlocked: boolean
    }
  | { phase: 'failed'; target: CallTarget; title: string; message: string }

type Session = {
  leave: () => void
  setAudio: (audio: CallAudio) => void
  startSound: () => void
}
type LiveKit = typeof import('livekit-client')

export const microphoneDenied = () =>
  document.documentElement.dataset.native
    ? "Huddle can't use your microphone. Allow Huddle in your system's microphone privacy settings, then quit and reopen Huddle."
    : "Huddle can't use your microphone. Allow it in your browser's settings for this site, then try again."
export const callsUnsupported = () =>
  document.documentElement.dataset.native
    ? "Huddle can't make calls on this system. Open this server in Chrome, Edge, or Safari."
    : "This browser can't make calls. Open Huddle in Chrome, Edge, or Safari."

/** Explains a refused `getUserMedia` by the error names browsers use, old and new. */
export function microphoneProblem(error: unknown) {
  const name = typeof error === 'object' && error && 'name' in error ? error.name : ''
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return microphoneDenied()
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return "Huddle can't find a microphone. Connect one, then try again."
    case 'NotReadableError':
    case 'TrackStartError':
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

type InputGain = {
  processor: TrackProcessor<Track.Kind.Audio, AudioProcessorOptions>
  set: (volume: number) => void
}

/** Scales the microphone before it is published. The graph runs on its own context, so it keeps
 *  working while the room's playback context waits for a click. */
function inputGain(context: AudioContext, volume: number): InputGain {
  const gain = context.createGain()
  gain.gain.value = volume
  const output = context.createMediaStreamDestination()
  gain.connect(output)
  let source: MediaStreamAudioSourceNode | null = null
  const wire = async ({ track }: AudioProcessorOptions) => {
    source?.disconnect()
    source = context.createMediaStreamSource(new MediaStream([track]))
    source.connect(gain)
  }
  return {
    processor: {
      name: 'huddle-input-volume',
      processedTrack: output.stream.getAudioTracks()[0],
      init: wire,
      restart: wire,
      async destroy() {
        source?.disconnect()
        source = null
      },
    },
    set: (next) => gain.gain.setTargetAtTime(next, context.currentTime, 0.02),
  }
}

/** Runs one attempt at one call. Everything it acquires is released on every path, so a person's
 *  microphone never stays open behind a call the interface says is over. */
function startCall(
  client: Transport,
  target: CallTarget,
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
  let mixer: AudioContext | null = null
  let gain: InputGain | null = null
  let inputDevice = 'default'
  let outputDevice = ''
  const outputVolume = () => (audio.kind === 'deafened' ? 0 : voiceSettings().output.volume)

  const stopFollowing = subscribeVoiceSettings(followSettings)
  navigator.mediaDevices?.addEventListener?.('devicechange', followSettings)
  function release() {
    if (over) return
    over = true
    if (target.kind === 'direct' && client.active)
      void client
        .request('/api/direct/calls/end', DirectCall, { callId: target.callId, action: 'hangup' })
        .catch(() => {})
    stopFollowing()
    navigator.mediaDevices?.removeEventListener?.('devicechange', followSettings)
    microphone?.stop()
    void mixer?.close().catch(() => {})
    mixer = null
    void room?.disconnect()
    for (const sound of sounds.keys()) sound.remove()
    sounds.clear()
  }
  async function setInputVolume(track: LocalAudioTrack, volume: number) {
    if (gain) return gain.set(volume)
    if (volume === 1) return
    mixer = new AudioContext()
    // Created after awaits, so it may start suspended, and a suspended graph publishes silence.
    void mixer.resume().catch(() => {})
    gain = inputGain(mixer, volume)
    await track.setAudioContext(mixer)
    await track.setProcessor(gain.processor)
  }
  /** Applies the stored settings, reading them when it runs so a burst of changes settles once. */
  async function applySettings() {
    if (over || !microphone) return
    const current = microphone
    const { input } = voiceSettings()
    for (const track of sounds.values()) track.setVolume(outputVolume())
    await setInputVolume(current, input.volume)
    if (over) return void current.stop()
    const wantedInput = (await presentDevice('input')) ?? 'default'
    const wantedOutput = (await presentDevice('output')) ?? ''
    if (over) return
    if (wantedInput !== inputDevice) {
      inputDevice = wantedInput
      await current.setDeviceId(wantedInput)
      if (over) return void current.stop()
    }
    if (sinkSupported() && wantedOutput !== outputDevice) {
      outputDevice = wantedOutput
      await Promise.all([...sounds.values()].map((track) => track.setSinkId(wantedOutput))).catch(
        () => {},
      )
    }
  }
  function followSettings() {
    audioChanges = audioChanges
      .then(applySettings)
      .catch(() => fail('Call ended', 'Your microphone stopped working.'))
  }
  function fail(title: string, message: string) {
    if (over) return
    release()
    onChange({ phase: 'failed', target, title, message })
  }
  const joinFailed = (message: string) => fail("Couldn't join", message)
  function report() {
    if (over || changingAudio || !inCall || !room || !microphone) return
    const { state } = room
    if (state === 'disconnected') return
    onChange({
      phase: state === 'connected' ? 'connected' : 'reconnecting',
      target,
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
    onChange({ phase: 'requesting-mic', target })
    if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection)
      return joinFailed(callsUnsupported())
    let lk: LiveKit
    try {
      lk = await import('livekit-client')
    } catch {
      return joinFailed("Huddle couldn't load what it needs for calls. Reload this page.")
    }
    if (over) return
    let grabbed: LocalAudioTrack
    try {
      // Before the microphone is allowed the list is nameless, so the stored ID is the best guess.
      const deviceId = (await presentDevice('input')) ?? voiceSettings().input.device?.id
      grabbed = await lk.createLocalAudioTrack(deviceId ? { deviceId } : undefined)
      // What was asked for, not what WebKit reports: there the default comes back as its hashed ID,
      // and comparing against that would restart the microphone right after joining.
      inputDevice = deviceId ?? 'default'
    } catch (error) {
      return joinFailed(microphoneProblem(error))
    }
    // A cancelled attempt still receives the microphone if the person answers the prompt afterwards.
    if (over) return void grabbed.stop()
    try {
      // Before publishing, so a lowered volume never goes out at full volume first.
      await setInputVolume(grabbed, voiceSettings().input.volume)
    } catch (error) {
      grabbed.stop()
      return joinFailed(microphoneProblem(error))
    }
    if (over) return void grabbed.stop()
    microphone = grabbed
    onChange({ phase: 'connecting', target })

    const grant = await client
      .request(
        target.kind === 'channel' ? '/api/voice/token' : '/api/direct/calls/token',
        VoiceGrant,
        target.kind === 'channel' ? { channelId: target.channelId } : { callId: target.callId },
      )
      .catch((error: unknown) => joinFailed(errorText(error)))
    if (over || !grant) return

    const joining = new lk.Room()
    room = joining
    let reachedService = false
    joining
      .on(lk.RoomEvent.SignalConnected, () => (reachedService = true))
      .on(lk.RoomEvent.TrackSubscribed, (track) => {
        if (!(track instanceof lk.RemoteAudioTrack) || over) return
        const volume = outputVolume()
        track.setVolume(volume)
        if (outputDevice) void track.setSinkId(outputDevice).catch(() => {})
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
    followSettings()
  }
  void begin().catch((error: unknown) => joinFailed(errorText(error)))

  return {
    leave: release,
    setAudio(next) {
      audioChanges = audioChanges
        .then(async () => {
          if (over) return
          // Before the prompt is answered there is nothing to mute yet, so joining reads the choice.
          if (!microphone) return void (audio = next)
          changingAudio = true
          if (microphoneMuted(next)) await microphone.mute()
          if (over) return void microphone.stop()
          audio = next
          for (const track of sounds.values()) track.setVolume(outputVolume())
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
  const [audio, setAudioState] = useState<CallAudio>({ kind: 'listening', muted: false })
  const latestAudio = useRef(audio)
  function choose(next: CallAudio) {
    latestAudio.current = next
    setAudioState(next)
    session.current?.setAudio(next)
  }
  useEffect(
    () => () => {
      session.current?.leave()
      session.current = null
    },
    [],
  )
  return {
    call,
    /** The person's audio choice, kept between calls so the next one starts the same way. */
    audio,
    /** Joins a channel, leaving any call already open and preserving the person's audio choices. */
    join(channelId: ChannelId) {
      session.current?.leave()
      session.current = startCall(
        client,
        { kind: 'channel', channelId },
        latestAudio.current,
        setCall,
      )
    },
    joinDirect(target: Extract<CallTarget, { kind: 'direct' }>) {
      session.current?.leave()
      session.current = startCall(client, target, latestAudio.current, setCall)
    },
    leave() {
      session.current?.leave()
      session.current = null
      setCall({ phase: 'idle' })
    },
    setMuted(next: boolean) {
      if (latestAudio.current.kind === 'deafened') return
      choose({ kind: 'listening', muted: next })
    },
    setDeafened(next: boolean) {
      const current = latestAudio.current
      if (next && current.kind === 'listening')
        choose({ kind: 'deafened', restoreMuted: current.muted })
      else if (!next && current.kind === 'deafened')
        choose({ kind: 'listening', muted: current.restoreMuted })
    },
    startSound: () => session.current?.startSound(),
  }
}
export type VoiceCall = ReturnType<typeof useVoiceCall>
