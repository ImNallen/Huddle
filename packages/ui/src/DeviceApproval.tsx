import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { z } from 'zod'
import { Check, Monitor, X } from 'lucide-react'
import { ServerInfo, type PublicUser } from '@huddle/contracts'
import { Application, Connecting } from './Application'
import { Avatar } from './Avatar'
import { Frame, Heading, Alert, Primary, hostOf } from './primitives'
import { RequestError, type Connection } from './connection'
import { errorText } from './transport'

const Claim = z.object({
  user_code: z.string(),
  status: z.enum(['pending', 'approved', 'denied']),
  client_id: z.literal('huddle-desktop'),
  requested_at: z.iso.datetime(),
})
type State =
  | { kind: 'entry' }
  | { kind: 'checking' }
  | { kind: 'claimed'; claim: z.infer<typeof Claim> }
  | { kind: 'done'; approved: boolean }
const alphabet = /[^ABCDEFGHJKLMNPQRSTUVWXYZ2-9]/g
const normalize = (value: string) => value.toUpperCase().replace(alphabet, '').slice(0, 8)
const display = (value: string) =>
  value.length > 4 ? `${value.slice(0, 4)}-${value.slice(4)}` : value
function describe(failure: unknown) {
  if (failure instanceof RequestError && (failure.code === 'expired' || failure.code === 'invalid'))
    return {
      lead: "That code isn't valid or has expired.",
      message: 'Check the code on your desktop, or start again there to get a new one.',
    }
  return { lead: errorText(failure) }
}
function requested(at: string) {
  const date = new Date(at)
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return date.toDateString() === new Date().toDateString()
    ? `Today, ${time}`
    : `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`
}
export function DeviceApproval({
  client,
  initialCode,
}: {
  client: Connection
  initialCode: string
}) {
  const [user, setUser] = useState<PublicUser | null>(null)
  const [code, setCode] = useState(() => normalize(initialCode))
  const [info, setInfo] = useState<z.infer<typeof ServerInfo> | null>(null)
  const [state, setState] = useState<State>(initialCode ? { kind: 'checking' } : { kind: 'entry' })
  const [busy, setBusy] = useState<'check' | 'approve' | 'deny' | null>(null)
  const [failure, setFailure] = useState<unknown>(null)
  const [matched, setMatched] = useState(false)
  useEffect(() => {
    const abort = new AbortController()
    void client
      .info()
      .then(setInfo)
      .catch((error: unknown) => {
        if (!abort.signal.aborted) setFailure(error)
      })
    return () => abort.abort()
  }, [client])
  const photo = useCallback(
    (uploadId: string, signal: AbortSignal) => client.photo(uploadId, signal),
    [client],
  )
  const lookup = useCallback(
    async (userCode: string) => {
      setBusy('check')
      setFailure(null)
      try {
        const claim = await client.request(
          `/api/auth/device?user_code=${encodeURIComponent(normalize(userCode))}`,
          Claim,
        )
        setState(
          claim.status === 'pending'
            ? { kind: 'claimed', claim }
            : { kind: 'done', approved: claim.status === 'approved' },
        )
        setMatched(false)
      } catch (error) {
        setState({ kind: 'entry' })
        setFailure(error)
      } finally {
        setBusy(null)
      }
    },
    [client],
  )
  useEffect(() => {
    if (user && initialCode) void lookup(initialCode)
  }, [user, initialCode, lookup])
  function check(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void lookup(code)
  }
  async function decide(decision: 'approve' | 'deny') {
    if (state.kind !== 'claimed' || (decision === 'approve' && !matched)) return
    setBusy(decision)
    setFailure(null)
    try {
      await client.act({ kind: 'device.decide', userCode: state.claim.user_code, decision })
      setState({ kind: 'done', approved: decision === 'approve' })
    } catch (error) {
      setFailure(error)
    } finally {
      setBusy(null)
    }
  }
  async function signOut() {
    try {
      await client.signOut()
    } finally {
      setUser(null)
      setState(initialCode ? { kind: 'checking' } : { kind: 'entry' })
    }
  }
  if (!user)
    return (
      <Application
        client={client}
        onReady={setUser}
        returnTo={`/device?user_code=${encodeURIComponent(initialCode)}`}
      />
    )
  const host = hostOf(client.origin)
  const server = info ? { name: info.name, origin: client.origin } : undefined
  const problem = failure ? describe(failure) : null
  if (state.kind === 'checking') return <Connecting server={server} title="Checking your code…" />
  return (
    <Frame
      server={server}
      account={user.email}
      onSignOut={() => void signOut()}
      wide={state.kind === 'claimed'}
    >
      {state.kind === 'entry' ? (
        <>
          <Heading
            title="Authorize a desktop"
            icon={<Monitor size={16} />}
            description="Enter the code shown in your Huddle desktop."
          />
          <form onSubmit={check}>
            <label className="access-label">
              Desktop code
              <input
                className="access-device-input"
                name="code"
                required
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder="XXXX-XXXX"
                value={display(code)}
                onChange={(event) => setCode(normalize(event.target.value))}
                aria-invalid={problem ? true : undefined}
                autoFocus
              />
            </label>
            <p className="access-hint">Letters and numbers. Dashes are added for you.</p>
            {problem && <Alert lead={problem.lead} message={problem.message} />}
            <Primary busy={busy === 'check'} disabled={busy !== null || code.length < 8}>
              Check code
            </Primary>
          </form>
          <hr className="access-rule" />
          <p className="access-note">Only enter a code from a desktop you're using right now.</p>
        </>
      ) : state.kind === 'claimed' ? (
        <div className="access-panel">
          <Heading
            title="Sign in to Huddle Desktop?"
            description="A desktop is asking to use your account."
          />
          <dl className="access-details">
            <div>
              <dt>App</dt>
              <dd>
                <Monitor size={13} />
                Huddle Desktop
              </dd>
            </div>
            <div>
              <dt>Server</dt>
              <dd>
                <code>{host}</code>
              </dd>
            </div>
            <div>
              <dt>Requested</dt>
              <dd>{requested(state.claim.requested_at)}</dd>
            </div>
          </dl>
          <p className="access-wait-label">Code</p>
          <div className="access-wait-code">
            <span>{state.claim.user_code.slice(0, 4)}</span>
            <i aria-hidden="true">–</i>
            <span>{state.claim.user_code.slice(4)}</span>
          </div>
          <label className="access-checkbox">
            <input
              type="checkbox"
              checked={matched}
              onChange={(event) => setMatched(event.target.checked)}
            />
            <span>I checked that this code matches my desktop.</span>
          </label>
          <Alert
            tone="warning"
            lead="Never approve a code someone else sent you."
            message="Anyone with an approved desktop can read and send messages as you."
          />
          {problem && <Alert lead={problem.lead} message={problem.message} />}
          <div className="access-actions-row">
            <button
              type="button"
              className="access-secondary access-danger"
              disabled={busy !== null}
              onClick={() => void decide('deny')}
            >
              Deny
            </button>
            <Primary
              type="button"
              busy={busy === 'approve'}
              disabled={busy !== null || !matched}
              onClick={() => void decide('approve')}
            >
              Approve this desktop
            </Primary>
          </div>
        </div>
      ) : (
        <div className="access-center">
          <Heading
            title={state.approved ? 'You’re connected' : 'Request denied'}
            icon={state.approved ? <Check size={20} /> : <X size={20} />}
            iconTone={state.approved ? 'success' : 'danger'}
            description={
              state.approved
                ? 'Huddle Desktop is signed in. You can close this tab and go back to the app.'
                : 'This desktop cannot use your account.'
            }
          />
          {state.approved ? (
            <div className="access-person">
              <Avatar avatar={user.avatar} name={user.name} photo={photo} size={32} />
              <div>
                <p>
                  <strong>{user.name}</strong>
                  <em>
                    <Monitor size={11} />
                    Huddle Desktop
                  </em>
                </p>
                <span>
                  {user.email} · <code>{host}</code>
                </span>
              </div>
            </div>
          ) : (
            <div className="access-card">
              <p>
                If you meant to sign in, start again from Huddle Desktop to get a new code. If you
                didn’t, there’s nothing else to do.
              </p>
            </div>
          )}
          <a className="access-secondary" href="/login">
            {state.approved
              ? 'Use Huddle in this browser instead'
              : `Go to ${info?.name ?? 'Huddle'}`}
          </a>
          <hr className="access-rule" />
          <p className="access-note">
            {state.approved ? 'Didn’t sign in just now?' : 'Seeing requests you didn’t make?'}{' '}
            <a className="access-link" href="/login?settings=security">
              Review account security
            </a>
          </p>
        </div>
      )}
      {state.kind === 'done' && problem && <Alert lead={problem.lead} message={problem.message} />}
    </Frame>
  )
}
