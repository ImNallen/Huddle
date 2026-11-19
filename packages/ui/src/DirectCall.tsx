import { useEffect, useRef, useState } from 'react'
import { CallId, DirectCall, type ConversationId, type UserId } from '@huddle/contracts'
import { errorText, type Transport } from './transport'
import type { useServer } from './useServer'
import type { VoiceCall } from './voiceCall'
import { CallControls, callStatus } from './Voice'

type Command =
  | { kind: 'start'; callId: CallId; conversationId: ConversationId }
  | { kind: 'accept'; callId: CallId }
  | { kind: 'end'; callId: CallId; action: 'decline' | 'cancel' | 'hangup' }

export function useDirectCalling(
  client: Transport,
  userId: UserId,
  sync: ReturnType<typeof useServer>,
  voice: VoiceCall,
) {
  const eligible = useRef<CallId | null>(null)
  const joining = useRef<CallId | null>(null)
  const operation = useRef(0)
  const observed = useRef<CallId | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [retry, setRetry] = useState<Command | null>(null)
  const [dismissed, setDismissed] = useState<CallId | null>(null)
  const call = sync.directCall
  async function command(input: Command) {
    if (busy && input.kind !== 'end') return
    const sequence = ++operation.current
    setBusy(true)
    setProblem(null)
    setRetry(input)
    if (input.kind === 'start' || input.kind === 'accept') {
      eligible.current = input.callId
      observed.current = input.callId
    }
    try {
      const { kind, ...body } = input
      const answer = await client.request(`/api/direct/calls/${kind}`, DirectCall, body)
      if (!client.active) return
      sync.observeDirectCall(answer)
      if (sequence === operation.current) setRetry(null)
    } catch (error) {
      if (client.active && sequence === operation.current) setProblem(errorText(error))
    } finally {
      if (sequence === operation.current) setBusy(false)
    }
  }
  useEffect(() => {
    if (!call) return
    if (call.state !== 'ended') observed.current = call.id
    if (call.state === 'accepted' && eligible.current === call.id && joining.current !== call.id) {
      joining.current = call.id
      voice.joinDirect({
        kind: 'direct',
        callId: call.id,
        conversationId: call.conversationId,
        name: call.callerId === userId ? call.calleeName : call.callerName,
      })
    }
    if (call.state === 'ended') {
      if (eligible.current === call.id) eligible.current = null
      if (
        voice.call.phase !== 'idle' &&
        voice.call.target.kind === 'direct' &&
        voice.call.target.callId === call.id &&
        voice.call.phase !== 'failed'
      )
        voice.leave()
    }
  }, [call, voice.call.phase])
  useEffect(
    () => () => {
      const id = eligible.current
      if (id && client.active)
        void client
          .request('/api/direct/calls/end', DirectCall, { callId: id, action: 'hangup' })
          .catch(() => {})
    },
    [],
  )
  return {
    call,
    busy,
    problem,
    dismissed,
    show: call?.state !== 'ended' || observed.current === call.id,
    start: (conversationId: ConversationId) => {
      if (voice.call.phase !== 'idle' && voice.call.target.kind === 'channel') voice.leave()
      void command({ kind: 'start', callId: CallId.parse(crypto.randomUUID()), conversationId })
    },
    accept: () => call && void command({ kind: 'accept', callId: call.id }),
    end: (action: 'decline' | 'cancel' | 'hangup') => {
      eligible.current = null
      if (voice.call.phase !== 'idle' && voice.call.target.kind === 'direct') voice.leave()
      if (call) void command({ kind: 'end', callId: call.id, action })
    },
    retry: retry ? () => void command(retry) : null,
    dismiss: () => {
      setDismissed(call?.id ?? null)
      setProblem(null)
      setRetry(null)
      if (voice.call.phase === 'failed') voice.leave()
    },
  }
}
const endedText = {
  declined: 'Call declined.',
  cancelled: 'Call cancelled.',
  hangup: 'Call ended.',
  timeout: 'No answer.',
  'join-timeout': 'The call could not connect.',
  disconnected: 'The connection to this call was lost.',
  'access-lost': 'The call ended because access could not be confirmed.',
  restart: 'The server restarted, so this call ended.',
}
export function DirectCallNotice({
  calling,
  voice,
  userId,
  onOpen,
}: {
  calling: ReturnType<typeof useDirectCalling>
  voice: VoiceCall
  userId: UserId
  onOpen: (call: DirectCall) => void
}) {
  const { call, busy, problem } = calling
  if ((!call || !calling.show) && !problem) return null
  if (call?.state === 'ended' && calling.dismissed === call.id && !problem) return null
  const incoming = call?.state === 'ringing' && call.calleeId === userId
  const media =
    voice.call.phase !== 'idle' &&
    voice.call.target.kind === 'direct' &&
    voice.call.target.callId === call?.id
      ? voice.call
      : null
  const roomCall =
    voice.call.phase !== 'idle' &&
    voice.call.phase !== 'failed' &&
    voice.call.target.kind === 'channel'
  const name = call && (call.callerId === userId ? call.calleeName : call.callerName)
  const status =
    call?.state === 'ended'
      ? endedText[call.reason]
      : incoming
        ? 'Incoming call'
        : call?.state === 'ringing'
          ? 'Calling…'
          : media
            ? callStatus(media)
            : 'Answered in another window.'
  return (
    <section className="direct-call-notice" aria-label="Private call">
      {call && (
        <button className="call-place" onClick={() => onOpen(call)}>
          <strong>{name}</strong>
          <span role="status">{status}</span>
        </button>
      )}
      {(problem || media?.phase === 'failed') && (
        <p role="alert">{problem ?? (media?.phase === 'failed' ? media.message : '')}</p>
      )}
      {media &&
        (media.phase === 'connected' || media.phase === 'reconnecting') &&
        media.soundBlocked && (
          <button className="button primary" onClick={voice.startSound}>
            Enable sound
          </button>
        )}
      <div className="direct-call-actions">
        {incoming && (
          <>
            <button className="button primary" disabled={busy} onClick={calling.accept}>
              {roomCall ? 'Leave and answer' : 'Accept'}
            </button>
            <button className="button" onClick={() => calling.end('decline')}>
              Decline
            </button>
          </>
        )}
        {call?.state === 'ringing' && !incoming && (
          <button className="button" onClick={() => calling.end('cancel')}>
            Cancel call
          </button>
        )}
        {call?.state === 'accepted' && (
          <>
            {media && (
              <CallControls voice={voice} status={status} onLeave={() => calling.end('hangup')} />
            )}
            <button className="button" onClick={() => calling.end('hangup')}>
              Hang up
            </button>
          </>
        )}
        {calling.retry && problem && (
          <button className="button" disabled={busy} onClick={calling.retry}>
            Try again
          </button>
        )}
        {(call?.state === 'ended' || (!call && problem)) && (
          <button className="button" onClick={calling.dismiss}>
            Dismiss
          </button>
        )}
      </div>
    </section>
  )
}
