import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { z } from 'zod'
import { Monitor, ShieldCheck } from 'lucide-react'
import { Application } from './Application'
import { Frame, Heading, Alert, Primary } from './primitives'
import type { Connection } from './connection'
import { errorText } from './transport'
import { ServerInfo } from '@huddle/contracts'

const Claim = z.object({
  user_code: z.string(),
  status: z.enum(['pending', 'approved', 'denied']),
  client_id: z.literal('huddle-desktop'),
})
type State =
  | { kind: 'entry' }
  | { kind: 'claimed'; claim: z.infer<typeof Claim> }
  | { kind: 'done'; approved: boolean }
export function DeviceApproval({
  client,
  initialCode,
}: {
  client: Connection
  initialCode: string
}) {
  const [admitted, setAdmitted] = useState(false)
  const [code, setCode] = useState(initialCode)
  const [info, setInfo] = useState<z.infer<typeof ServerInfo> | null>(null)
  const [state, setState] = useState<State>({ kind: 'entry' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [matched, setMatched] = useState(false)
  useEffect(() => {
    const abort = new AbortController()
    void client
      .info()
      .then(setInfo)
      .catch((failure) => {
        if (!abort.signal.aborted) setError(errorText(failure))
      })
    return () => abort.abort()
  }, [client])
  const ready = useCallback(() => setAdmitted(true), [])
  async function check(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const claim = await client.request(
        `/api/auth/device?user_code=${encodeURIComponent(code.trim())}`,
        Claim,
      )
      setState(
        claim.status === 'pending'
          ? { kind: 'claimed', claim }
          : { kind: 'done', approved: claim.status === 'approved' },
      )
      setMatched(false)
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(false)
    }
  }
  async function decide(decision: 'approve' | 'deny') {
    if (state.kind !== 'claimed' || (decision === 'approve' && !matched)) return
    setBusy(true)
    setError('')
    try {
      await client.act({ kind: 'device.decide', userCode: state.claim.user_code, decision })
      setState({ kind: 'done', approved: decision === 'approve' })
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(false)
    }
  }
  if (!admitted)
    return (
      <Application
        client={client}
        onReady={ready}
        returnTo={`/device?user_code=${encodeURIComponent(initialCode)}`}
      />
    )
  return (
    <Frame server={info ? { name: info.name, origin: client.origin } : undefined}>
      {state.kind === 'entry' ? (
        <>
          <Heading
            title="Connect your desktop"
            icon={<Monitor size={20} />}
            description="Enter the code shown in your Huddle desktop."
          />
          <form onSubmit={check}>
            <label className="access-label">
              Device code
              <input
                name="code"
                required
                autoComplete="off"
                maxLength={32}
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
            </label>
            <Primary busy={busy}>Check code</Primary>
          </form>
        </>
      ) : state.kind === 'claimed' ? (
        <div className="access-card">
          <Heading
            title="Sign in to Huddle Desktop?"
            icon={<ShieldCheck size={20} />}
            description={`Huddle Desktop is asking to sign in to ${info?.name ?? 'this server'} with your account.`}
          />
          <div className="access-row">
            <span>App</span>
            <strong>Huddle Desktop</strong>
          </div>
          <div className="access-row">
            <span>Server</span>
            <code>{new URL(client.origin).host}</code>
          </div>
          <p className="access-note">Does this match the code on your desktop?</p>
          <div className="access-wait-code">{state.claim.user_code}</div>
          <label className="access-checkbox">
            <input
              type="checkbox"
              checked={matched}
              onChange={(event) => setMatched(event.target.checked)}
            />
            <span>I checked that this code matches my desktop.</span>
          </label>
          <p className="access-note">
            Only approve if you started this sign-in yourself and the code matches. Never approve a
            code someone else sent you.
          </p>
          <Primary busy={busy} disabled={!matched} onClick={() => void decide('approve')}>
            Approve this desktop
          </Primary>
          <button
            className="access-secondary access-danger"
            disabled={busy}
            onClick={() => void decide('deny')}
          >
            Deny
          </button>
        </div>
      ) : (
        <>
          <Heading
            title={state.approved ? 'You are connected' : 'Request denied'}
            icon={<ShieldCheck size={20} />}
            description={
              state.approved
                ? 'Return to Huddle Desktop. You can close this window.'
                : 'This desktop cannot use your account.'
            }
          />
          <a className="access-link" href="/login">
            Open Huddle
          </a>
        </>
      )}
      <Alert message={error} />
    </Frame>
  )
}
