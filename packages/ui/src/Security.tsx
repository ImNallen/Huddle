import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { LogOut, ShieldCheck, X } from 'lucide-react'
import {
  AccountSecurity,
  type AccessCommand,
  type AccessView,
  type Profile,
} from '@huddle/contracts'
import { Alert, Heading, Primary } from './primitives'
import { ProfileEditor } from './Avatar'
import { clock } from './Badges'
import { RequestError, type Connection } from './connection'
import { sessionLabel } from './sessionLabel'
import { errorText } from './transport'

export function Security({
  client,
  accept,
  close,
  signOut,
}: {
  client: Connection
  accept: (view: AccessView, signal?: AbortSignal) => Promise<void>
  close: () => void
  signOut: () => void
}) {
  const [inventory, setInventory] = useState<z.infer<typeof AccountSecurity> | null>(null)
  const [tab, setTab] = useState<'security' | 'profile'>('security')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const lifetime = useRef(new AbortController())
  useEffect(() => {
    const abort = new AbortController()
    lifetime.current = abort
    void client
      .request('/api/account', AccountSecurity, undefined, abort.signal)
      .then(setInventory)
      .catch((failure) => {
        if (!abort.signal.aborted) setError(errorText(failure))
      })
    return () => abort.abort()
  }, [client])
  async function reload() {
    const value = await client.request(
      '/api/account',
      AccountSecurity,
      undefined,
      lifetime.current.signal,
    )
    if (!lifetime.current.signal.aborted) setInventory(value)
  }
  async function send(command: AccessCommand) {
    const signal = lifetime.current.signal
    await accept(await client.act(command, signal), signal)
    if (!signal.aborted) await reload()
  }
  async function apply(command: AccessCommand) {
    setBusy(true)
    setError('')
    const signal = lifetime.current.signal
    try {
      await send(command)
    } catch (failure) {
      if (!signal.aborted) setError(errorText(failure))
    } finally {
      if (!signal.aborted) setBusy(false)
    }
  }
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])
  const others = inventory?.sessions.some((session) => !session.current) ?? false
  return (
    <div className="settings">
      <aside className="settings-side">
        <nav className="settings-nav" aria-label="Account settings">
          <button
            aria-current={tab === 'profile' ? 'page' : undefined}
            onClick={() => setTab('profile')}
          >
            Profile
          </button>
          <button
            aria-current={tab === 'security' ? 'page' : undefined}
            onClick={() => setTab('security')}
          >
            Account security
          </button>
          <hr />
          <button className="settings-signout" onClick={signOut}>
            Sign out
            <LogOut size={16} />
          </button>
        </nav>
      </aside>
      <main className="settings-main">
        <div className="settings-content">
          <Heading
            title={tab === 'security' ? 'Account security' : 'Your profile'}
            description={
              tab === 'security'
                ? 'Sign out sessions you don’t recognize and change your password.'
                : 'Your name and avatar are shared across this server.'
            }
          />
          {!inventory ? (
            <>
              <p role="status">Loading your account…</p>
              <Alert message={error} />
              <button
                className="access-link"
                onClick={() => void reload().catch((failure) => setError(errorText(failure)))}
              >
                Try again
              </button>
            </>
          ) : tab === 'profile' ? (
            <>
              <ProfileEditor
                initial={{ name: inventory.user.name, avatar: inventory.user.avatar }}
                save={(profile: Profile) => apply({ kind: 'profile.save', profile })}
                busy={busy}
                upload={(file) => client.upload(file)}
                photo={(id, signal) => client.photo(id, signal)}
                submitLabel="Save profile"
              />
              <Alert message={error} />
            </>
          ) : (
            <>
              <section className="access-card">
                <div className="access-row">
                  <div>
                    <h2>Active sessions</h2>
                    <p>Where you're signed in to this server.</p>
                  </div>
                  {others && (
                    <button
                      className="access-link access-danger"
                      disabled={busy}
                      onClick={() => void apply({ kind: 'sessions.revoke-others' })}
                    >
                      Sign out all other sessions
                    </button>
                  )}
                </div>
                {inventory.sessions.map((session) => (
                  <div className="access-row access-security-row" key={session.id}>
                    <ShieldCheck size={18} />
                    <div className="access-security-detail">
                      <strong>
                        {sessionLabel(session.userAgent)}
                        {session.current ? ' · This device' : ''}
                      </strong>
                      <p>
                        Signed in {date(session.createdAt)}. Expires {date(session.expiresAt)}.
                      </p>
                    </div>
                    {!session.current && (
                      <button
                        className="access-link"
                        disabled={busy}
                        onClick={() => void apply({ kind: 'session.revoke', id: session.id })}
                      >
                        Sign out
                      </button>
                    )}
                  </div>
                ))}
              </section>
              <Alert message={error} />
              <PasswordForm
                change={(current, next) => send({ kind: 'password.change', current, next })}
              />
            </>
          )}
        </div>
        <div className="settings-close">
          <button aria-label="Back to chat" title="Back to chat" onClick={close}>
            <X size={18} />
          </button>
          <span aria-hidden="true">ESC</span>
        </div>
      </main>
    </div>
  )
}

type PasswordStatus =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'failed'; message: string }
  | { kind: 'changed' }
function PasswordForm({ change }: { change: (current: string, next: string) => Promise<void> }) {
  const [status, setStatus] = useState<PasswordStatus>({ kind: 'idle' })
  async function submit(form: HTMLFormElement) {
    const fields = new FormData(form)
    const current = String(fields.get('current') ?? '')
    const next = String(fields.get('next') ?? '')
    if (next !== String(fields.get('confirm') ?? '')) {
      setStatus({ kind: 'failed', message: 'The new passwords don’t match.' })
      return
    }
    setStatus({ kind: 'busy' })
    try {
      await change(current, next)
      form.reset()
      setStatus({ kind: 'changed' })
    } catch (failure) {
      setStatus({ kind: 'failed', message: passwordError(failure) })
    }
  }
  return (
    <section className="access-card">
      <h2>Change password</h2>
      <p>Changing your password signs out your other sessions.</p>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void submit(event.currentTarget)
        }}
      >
        <PasswordField name="current" label="Current password" autoComplete="current-password" />
        <PasswordField name="next" label="New password" autoComplete="new-password" />
        <PasswordField name="confirm" label="Confirm new password" autoComplete="new-password" />
        <Primary busy={status.kind === 'busy'}>Change password</Primary>
      </form>
      {status.kind === 'changed' && (
        <p className="access-note" role="status">
          Password changed. Your other sessions were signed out.
        </p>
      )}
      {status.kind === 'failed' && <Alert message={status.message} />}
    </section>
  )
}
function PasswordField({
  name,
  label,
  autoComplete,
}: {
  name: string
  label: string
  autoComplete: string
}) {
  return (
    <label className="access-label">
      {label}
      <input
        name={name}
        type="password"
        required
        minLength={8}
        maxLength={200}
        autoComplete={autoComplete}
      />
    </label>
  )
}
function passwordError(failure: unknown) {
  if (!(failure instanceof RequestError)) return errorText(failure)
  if (failure.code === 'invalid') return 'Your current password is incorrect.'
  if (failure.code === 'rate_limited')
    return failure.retryAt
      ? `Too many password attempts. Try again after ${clock(failure.retryAt)}.`
      : 'Too many password attempts. Try again later.'
  return errorText(failure)
}
function date(value: string) {
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}
