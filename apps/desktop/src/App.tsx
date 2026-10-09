import { useEffect, useRef, useState, type FormEvent } from 'react'
import { z } from 'zod'
import { ArrowRight, Check, Globe2, MessageSquare, Monitor, Server, X } from 'lucide-react'
import { DeviceCode, DeviceToken, type Session } from '@huddle/contracts'
import { Client, errorText, native, openBrowser, RequestError } from './client'
import { Chat } from './Chat'

type Account = { kind: 'loading' } | { kind: 'signedOut' } | { kind: 'signedIn'; session: Session }
type Device =
  | { kind: 'idle' }
  | { kind: 'waiting'; code: z.infer<typeof DeviceCode>; expiresAt: number }
  | { kind: 'failed'; message: string }
export function App() {
  const [client, setClient] = useState(
    () => new Client(localStorage.getItem('huddle.server') ?? 'http://localhost:3000'),
  )
  const [account, setAccount] = useState<Account>({ kind: 'loading' })
  const [connectionError, setConnectionError] = useState('')
  const [editingServer, setEditingServer] = useState(false)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let cancelled = false
    setAccount({ kind: 'loading' })
    setConnectionError('')
    void client
      .restore()
      .then(() => client.session())
      .then((session) => {
        if (!cancelled) setAccount(session ? { kind: 'signedIn', session } : { kind: 'signedOut' })
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setConnectionError(errorText(error))
          setAccount({ kind: 'signedOut' })
        }
      })
    return () => {
      cancelled = true
    }
  }, [client, reload])
  async function changeServer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    try {
      const origin = z.string().parse(new FormData(event.currentTarget).get('server'))
      const next = new Client(origin)
      client.disconnect()
      await client.forget()
      localStorage.setItem('huddle.server', next.origin)
      setClient(next)
      setEditingServer(false)
      setConnectionError('')
    } catch (error) {
      setConnectionError(errorText(error))
    }
  }
  async function logout() {
    try {
      await client.signOut()
    } catch (error) {
      setConnectionError(errorText(error))
    } finally {
      setAccount({ kind: 'signedOut' })
    }
  }
  return (
    <>
      {account.kind === 'signedIn' ? (
        <Chat
          key={`${client.origin}:${account.session.user.id}`}
          client={client}
          session={account.session}
          onLogout={() => void logout()}
          onServer={() => setEditingServer(true)}
        />
      ) : (
        <div className="welcome">
          <aside className="welcome-story">
            <div className="wordmark">
              huddle
              <span />
            </div>
            <div>
              <p className="eyebrow">A LITTLE CLOSER, EVEN FROM HERE.</p>
              <h1>
                Good work starts
                <br />
                with a conversation.
              </h1>
              <p>
                A home for your team's everyday ideas.
                <br />
                On a server you call your own.
              </p>
              <div className="abstract-chat" aria-hidden="true">
                <div className="abstract-heading">
                  <MessageSquare size={19} />
                  <span>A space for your team</span>
                  <span className="mini-dot" />
                </div>
                <div className="abstract-line">
                  <i />
                  <span />
                  <span />
                </div>
                <div className="abstract-line short">
                  <i />
                  <span />
                  <span />
                </div>
                <div className="abstract-composer">
                  Make room for the next idea.
                  <ArrowRight size={16} />
                </div>
              </div>
            </div>
            <p className="story-footer">
              <span className="mini-dot" /> Your conversations. Your company.
            </p>
          </aside>
          <main className="welcome-form">
            <button className="server-chip" onClick={() => setEditingServer(true)}>
              <Server size={15} />
              <span>{new URL(client.origin).host}</span>
              <span className="muted">Change</span>
            </button>
            {account.kind === 'loading' ? (
              <div className="center-state" role="status">
                Connecting to your server…
              </div>
            ) : (
              <Login
                key={client.origin}
                client={client}
                onSession={(session) => {
                  if (client.active) setAccount({ kind: 'signedIn', session })
                }}
              />
            )}
            {connectionError && (
              <div className="error-box" role="alert">
                {connectionError}
                <button className="text-button" onClick={() => setReload(reload + 1)}>
                  Try connection again
                </button>
              </div>
            )}
            <p className="login-footer">Your account lives on this Huddle server.</p>
          </main>
        </div>
      )}
      {editingServer && (
        <div className="modal-backdrop">
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="server-title">
            <button
              className="icon-button modal-close"
              aria-label="Close server settings"
              onClick={() => setEditingServer(false)}
            >
              <X size={18} />
            </button>
            <Globe2 className="accent" size={28} />
            <h2 id="server-title">Connect to your company</h2>
            <p>
              Enter the server address from your team. Each server has its own account and
              workspaces.
            </p>
            <form onSubmit={(event) => void changeServer(event)}>
              <label>
                Server address
                <input
                  name="server"
                  type="url"
                  defaultValue={client.origin}
                  placeholder="https://huddle.company.com"
                  required
                />
              </label>
              {connectionError && (
                <p role="alert" className="error">
                  {connectionError}
                </p>
              )}
              <button className="primary">
                Connect to server
                <ArrowRight size={16} />
              </button>
            </form>
          </section>
        </div>
      )}
    </>
  )
}

function Login({ client, onSession }: { client: Client; onSession: (session: Session) => void }) {
  const lifetime = useRef(new AbortController())
  useEffect(() => {
    lifetime.current = new AbortController()
    return () => lifetime.current.abort()
  }, [])
  const [signup, setSignup] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [device, setDevice] = useState<Device>({ kind: 'idle' })
  const [oidc, setOidc] = useState(false)
  useEffect(() => {
    void client
      .info()
      .then((info) => setOidc(info.oidc))
      .catch(() => {})
  }, [client])
  useEffect(() => {
    if (device.kind !== 'waiting') return
    let cancelled = false
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    let interval = device.code.interval * 1000
    async function poll() {
      if (cancelled || device.kind !== 'waiting') return
      if (Date.now() >= device.expiresAt) {
        setDevice({ kind: 'failed', message: 'This code expired. Start again to get a new code.' })
        return
      }
      try {
        const result = await client.request(
          '/api/auth/device/token',
          DeviceToken,
          {
            client_id: 'huddle-desktop',
            device_code: device.code.device_code,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          },
          abort.signal,
        )
        if (cancelled) return
        await client.remember(result.access_token, abort.signal)
        const session = await client.session(abort.signal)
        if (session && !cancelled && client.active) onSession(session)
      } catch (error) {
        if (cancelled) return
        if (
          error instanceof RequestError &&
          ['authorization_pending', 'slow_down'].includes(error.message)
        ) {
          if (error.message === 'slow_down') interval += 5000
          timer = setTimeout(() => void poll(), interval)
        } else setDevice({ kind: 'failed', message: errorText(error) })
      }
    }
    timer = setTimeout(() => void poll(), interval)
    return () => {
      cancelled = true
      abort.abort()
      clearTimeout(timer)
    }
  }, [client, device, onSession])
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    const form = new FormData(event.currentTarget)
    const signal = lifetime.current.signal
    try {
      const result = await client.request(
        signup ? '/api/auth/sign-up/email' : '/api/auth/sign-in/email',
        z.object({ token: z.string().nullable() }),
        {
          email: form.get('email'),
          password: form.get('password'),
          ...(signup ? { name: form.get('name') } : {}),
        },
        signal,
      )
      if (signal.aborted || !client.active) return
      if (result.token) await client.remember(result.token, signal)
      const session = await client.session(signal)
      if (!session)
        throw new Error(
          'Could not establish a session. Check your server address and cookie settings.',
        )
      if (!signal.aborted && client.active) onSession(session)
    } catch (error) {
      setError(errorText(error))
    } finally {
      setBusy(false)
    }
  }
  async function deviceLogin() {
    const signal = lifetime.current.signal
    setError('')
    setBusy(true)
    try {
      if (!native) {
        const response = await client.request(
          '/api/auth/sign-in/oauth2',
          z.object({ url: z.url() }),
          { providerId: 'company', callbackURL: window.location.href },
          signal,
        )
        if (!signal.aborted && client.active) window.location.assign(response.url)
        return
      }
      const code = await client.request(
        '/api/auth/device/code',
        DeviceCode,
        {
          client_id: 'huddle-desktop',
        },
        signal,
      )
      if (signal.aborted || !client.active) return
      setDevice({ kind: 'waiting', code, expiresAt: Date.now() + code.expires_in * 1000 })
      await openBrowser(code.verification_uri_complete ?? code.verification_uri)
    } catch (error) {
      setError(errorText(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="login-content">
      <div className="login-symbol">
        <MessageSquare size={24} />
      </div>
      <h2>{signup ? 'Make yourself at home.' : 'Welcome back.'}</h2>
      <p>
        {signup
          ? 'Create an account, then start a workspace or join with an invitation.'
          : 'Sign in and pick up the conversation.'}
      </p>
      <form onSubmit={submit}>
        {signup && (
          <label>
            Your name
            <input
              name="name"
              autoComplete="name"
              placeholder="How your team knows you"
              required
              maxLength={80}
            />
          </label>
        )}
        <label>
          Email address
          <input
            name="email"
            type="email"
            autoComplete="email"
            placeholder="you@company.com"
            required
          />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            autoComplete={signup ? 'new-password' : 'current-password'}
            placeholder={signup ? 'At least 12 characters' : 'Your password'}
            minLength={12}
            required
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy}>
          {busy ? 'Connecting…' : signup ? 'Create account' : 'Sign in'}
          <ArrowRight size={17} />
        </button>
      </form>
      {(native || oidc) && (
        <>
          <div className="divider">
            <span>or</span>
          </div>
          <button className="secondary wide" disabled={busy} onClick={() => void deviceLogin()}>
            <Monitor size={16} />
            {native ? 'Sign in with your browser' : 'Continue with company login'}
          </button>
        </>
      )}
      {device.kind === 'waiting' && (
        <div className="device-panel" role="status">
          <p>Match this code in your browser</p>
          <strong>{device.code.user_code}</strong>
          <p>Waiting for your approval…</p>
          <button className="text-button" onClick={() => setDevice({ kind: 'idle' })}>
            Cancel
          </button>
        </div>
      )}
      {device.kind === 'failed' && (
        <p role="alert" className="error">
          {device.message}
        </p>
      )}
      <p className="switch-auth">
        {signup ? 'Already a member?' : 'First time here?'}{' '}
        <button
          className="text-button"
          onClick={() => {
            setSignup(!signup)
            setError('')
          }}
        >
          {signup ? 'Sign in' : 'Create an account'}
        </button>
      </p>
      <p className="private-note">
        <Check size={13} /> Workspaces are private until you invite someone.
      </p>
    </div>
  )
}
