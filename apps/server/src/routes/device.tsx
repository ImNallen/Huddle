import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState, type FormEvent } from 'react'
import { z } from 'zod'
import { Session } from '@huddle/contracts'
import { authRequest } from '../lib/browser-auth'
export const Route = createFileRoute('/device')({ component: Device })
type Approval =
  | { kind: 'entry' }
  | { kind: 'claimed'; code: string; clientId: string }
  | { kind: 'done'; approved: boolean }
function Device() {
  const [code, setCode] = useState('')
  const [state, setState] = useState<Approval>({ kind: 'entry' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setCode(new URLSearchParams(window.location.search).get('user_code') ?? '')
    void authRequest('/get-session')
      .then((session) => {
        if (!Session.safeParse(session).success)
          window.location.assign(
            `/login?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`,
          )
      })
      .catch(() => setError('Could not check your session. Reload to try again.'))
  }, [])
  async function verify(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const request = z
        .object({ client_id: z.string() })
        .parse(await authRequest(`/device?user_code=${encodeURIComponent(code)}`))
      setState({ kind: 'claimed', code, clientId: request.client_id })
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Invalid code.')
    } finally {
      setBusy(false)
    }
  }
  async function decide(approved: boolean) {
    if (state.kind !== 'claimed') return
    setBusy(true)
    setError('')
    try {
      await authRequest(approved ? '/device/approve' : '/device/deny', { userCode: state.code })
      setState({ kind: 'done', approved })
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Authorization failed.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className="card">
      <a className="brand" href="/">
        huddle<span>●</span>
      </a>
      <h1>
        {state.kind === 'done'
          ? state.approved
            ? 'You are connected.'
            : 'Request denied.'
          : 'Connect your desktop.'}
      </h1>
      {state.kind === 'entry' && (
        <form onSubmit={verify}>
          <p>Enter the code shown in your Huddle desktop.</p>
          <label>
            Device code
            <input
              name="code"
              autoComplete="off"
              required
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
          <button disabled={busy}>Check code</button>
        </form>
      )}
      {state.kind === 'claimed' && (
        <>
          <p>
            Authorize{' '}
            <strong>
              {state.clientId === 'huddle-desktop' ? 'Huddle Desktop' : state.clientId}
            </strong>{' '}
            to use your account.
          </p>
          <p className="device-code">{state.code}</p>
          <p>
            Confirm that this code matches your desktop. Approve only a device in your possession.
            Do not approve codes sent by someone else.
          </p>
          <button disabled={busy} onClick={() => void decide(true)}>
            Approve this desktop
          </button>
          <button className="secondary" disabled={busy} onClick={() => void decide(false)}>
            Deny
          </button>
        </>
      )}
      {state.kind === 'done' && (
        <p>
          {state.approved
            ? 'Return to Huddle. You can close this window.'
            : 'This device cannot use your account.'}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </main>
  )
}
