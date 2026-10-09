import { useEffect, useRef, useState, type FormEvent } from 'react'
import { z } from 'zod'
import { KeyRound, ShieldCheck } from 'lucide-react'
import {
  AccountSecurity,
  type AccessView,
  type FactorInput,
  type SecurityChange,
  type Profile,
} from '@huddle/contracts'
import { Alert, CodeField, Dialog, Frame, Heading, Primary } from './primitives'
import { ProfileEditor } from './Avatar'
import { addPasskey, provePasskey } from './passkeys'
import type { Connection } from './connection'
import { errorText } from './transport'

type Action = { kind: 'change'; change: SecurityChange; title: string } | { kind: 'add-passkey' }
export function Security({
  client,
  accept,
  close,
  signOut,
  browser,
}: {
  client: Connection
  accept: (view: AccessView, signal?: AbortSignal) => Promise<void>
  close: () => void
  signOut: () => void
  browser?: () => Promise<void>
}) {
  const [inventory, setInventory] = useState<z.infer<typeof AccountSecurity> | null>(null)
  const [tab, setTab] = useState<'security' | 'profile'>('security')
  const [action, setAction] = useState<Action | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [rename, setRename] = useState<{ id: string; name: string } | null>(null)
  const [passkeyName, setPasskeyName] = useState('My passkey')
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
  async function commit(proof: FactorInput) {
    if (!action) return
    setBusy(true)
    setError('')
    const signal = lifetime.current.signal
    try {
      const view =
        action.kind === 'add-passkey'
          ? await addPasskey(client, passkeyName, signal, proof)
          : await client.act({ kind: 'security.commit', change: action.change, proof }, signal)
      await accept(view, signal)
      if (!signal.aborted) {
        setAction(null)
        await reload()
      }
    } catch (failure) {
      if (!signal.aborted) setError(errorText(failure))
    } finally {
      if (!signal.aborted) setBusy(false)
    }
  }
  async function passkeyProof() {
    if (browser) {
      await browser()
      return
    }
    setBusy(true)
    setError('')
    try {
      await commit(await provePasskey(client, lifetime.current.signal))
    } catch (failure) {
      if (!lifetime.current.signal.aborted) setError(errorText(failure))
    } finally {
      if (!lifetime.current.signal.aborted) setBusy(false)
    }
  }
  async function saveProfile(profile: Profile) {
    setBusy(true)
    setError('')
    try {
      await accept(
        await client.act({ kind: 'profile.save', profile }, lifetime.current.signal),
        lifetime.current.signal,
      )
      await reload()
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(false)
    }
  }
  function request(change: SecurityChange, title: string) {
    setError('')
    setAction({ kind: 'change', change, title })
  }
  function renameSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!rename) return
    const name = z.string().parse(new FormData(event.currentTarget).get('name'))
    setRename(null)
    request({ kind: 'passkey.rename', id: rename.id, name }, 'Rename passkey')
  }
  const companySessionChange =
    action?.kind === 'change' &&
    (action.change.kind === 'session.revoke' || action.change.kind === 'sessions.revoke-others') &&
    inventory?.sessions.some((session) => session.current && session.method === 'company') &&
    (inventory.policy === 'sso-only' ||
      (!inventory.authenticator && inventory.passkeys.length === 0))
      ? action.change
      : null
  async function companyConfirm() {
    if (!companySessionChange) return
    setBusy(true)
    setError('')
    try {
      const result = await client.request(
        '/api/auth/sign-in/oauth2',
        z.object({ url: z.url() }),
        {
          providerId: 'company',
          callbackURL: '/login?settings=security',
          purpose: 'session-security',
          change: companySessionChange,
        },
        lifetime.current.signal,
      )
      if (client.active && !lifetime.current.signal.aborted) window.location.assign(result.url)
    } catch (failure) {
      if (!lifetime.current.signal.aborted) {
        setError(errorText(failure))
        setBusy(false)
      }
    }
  }
  return (
    <Frame account={inventory?.user.email} onSignOut={signOut} wide>
      <div className="access-security">
        <button className="access-link" onClick={close}>
          ← Back to workspace
        </button>
        <div className="access-security-layout">
          <nav className="access-security-nav" aria-label="Account settings">
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
          </nav>
          <div>
            <Heading
              title={tab === 'security' ? 'Account security' : 'Your profile'}
              description={
                tab === 'security'
                  ? 'How you sign in to this server. Sensitive changes ask you to verify who you are.'
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
                  save={saveProfile}
                  busy={busy}
                  upload={(file) => client.upload(file)}
                  photo={(id, signal) => client.photo(id, signal)}
                />
                <Alert message={error} />
              </>
            ) : (
              <>
                {inventory.policy === 'sso-only' && (
                  <p className="access-note">
                    This server requires company sign-in. Local authenticator, recovery and passkey
                    changes are disabled by its policy.
                  </p>
                )}
                <section className="access-card">
                  <div className="access-row">
                    <div>
                      <h2>Passkeys</h2>
                      <p>Sign in with your fingerprint, face or device PIN.</p>
                    </div>
                    {inventory.policy === 'mixed' && (
                      <button
                        className="access-link"
                        onClick={() => {
                          setAction({ kind: 'add-passkey' })
                          setError('')
                        }}
                      >
                        + Add passkey
                      </button>
                    )}
                  </div>
                  {inventory.passkeys.length ? (
                    inventory.passkeys.map((key) => (
                      <div className="access-row access-security-row" key={key.id}>
                        <KeyRound size={18} />
                        <div style={{ flex: 1 }}>
                          <strong>{key.name}</strong>
                          <p>
                            Added {date(key.createdAt)}
                            {key.lastUsedAt
                              ? ` · Last used ${date(key.lastUsedAt)}`
                              : ' · Not used yet'}
                          </p>
                        </div>
                        {inventory.policy === 'mixed' && (
                          <>
                            {' '}
                            <button
                              className="access-link"
                              onClick={() => setRename({ id: key.id, name: key.name })}
                            >
                              Rename
                            </button>
                            <button
                              className="access-link access-danger"
                              onClick={() =>
                                request({ kind: 'passkey.remove', id: key.id }, 'Remove passkey')
                              }
                            >
                              Remove
                            </button>
                          </>
                        )}
                      </div>
                    ))
                  ) : (
                    <p>No passkeys added.</p>
                  )}
                </section>
                <section className="access-card">
                  <div className="access-row">
                    <div>
                      <h2>
                        Authenticator app{' '}
                        {inventory.authenticator && <span className="access-link">· Set up</span>}
                      </h2>
                      <p>
                        {inventory.authenticator
                          ? `Added ${date(inventory.authenticator.enrolledAt)}. Used when signing in with email.`
                          : 'No local authenticator is enrolled.'}
                      </p>
                    </div>
                    {inventory.policy === 'mixed' && inventory.authenticator && (
                      <button
                        className="access-link"
                        onClick={() =>
                          request({ kind: 'authenticator.replace' }, 'Replace authenticator')
                        }
                      >
                        Replace authenticator
                      </button>
                    )}
                  </div>
                </section>
                <section className="access-card">
                  <div className="access-row">
                    <div>
                      <h2>Recovery codes</h2>
                      <p>
                        {inventory.recoveryRemaining} of {inventory.recoveryTotal} codes remaining.
                        {inventory.recoveryCreatedAt &&
                          ` Created ${date(inventory.recoveryCreatedAt)}.`}
                      </p>
                      <p>Each code works once if you lose your authenticator.</p>
                    </div>
                    {inventory.policy === 'mixed' && inventory.authenticator && (
                      <button
                        className="access-link"
                        onClick={() =>
                          request({ kind: 'recovery.regenerate' }, 'Regenerate recovery codes')
                        }
                      >
                        Regenerate codes
                      </button>
                    )}
                  </div>
                </section>
                <section className="access-card">
                  <div className="access-row">
                    <div>
                      <h2>Active sessions</h2>
                      <p>Where you're signed in to this server.</p>
                    </div>
                    {inventory.sessions.some((session) => !session.current) && (
                      <button
                        className="access-link access-danger"
                        onClick={() =>
                          request({ kind: 'sessions.revoke-others' }, 'Sign out all other sessions')
                        }
                      >
                        Sign out all others
                      </button>
                    )}
                  </div>
                  {inventory.sessions.map((session) => (
                    <div className="access-row access-security-row" key={session.id}>
                      <ShieldCheck size={18} />
                      <div style={{ flex: 1 }}>
                        <strong>
                          {session.userAgent || 'Session'}
                          {session.current ? ' · This session' : ''}
                        </strong>
                        <p>
                          Signed in {date(session.createdAt)} with {session.method}. Expires{' '}
                          {date(session.expiresAt)}.
                        </p>
                      </div>
                      {!session.current && (
                        <button
                          className="access-link"
                          onClick={() =>
                            request({ kind: 'session.revoke', id: session.id }, 'Sign out session')
                          }
                        >
                          Sign out
                        </button>
                      )}
                    </div>
                  ))}
                </section>
                {!action && !rename && <Alert message={error} />}
              </>
            )}
          </div>
        </div>
      </div>
      {rename && (
        <Dialog title="Rename passkey" close={() => setRename(null)}>
          <form onSubmit={renameSubmit}>
            <label className="access-label">
              Passkey name
              <input name="name" required maxLength={80} defaultValue={rename.name} />
            </label>
            <Primary>Continue</Primary>
          </form>
        </Dialog>
      )}
      {action && (
        <Dialog
          title={action.kind === 'add-passkey' ? 'Add a passkey' : action.title}
          close={() => {
            if (!busy) setAction(null)
          }}
        >
          <p className="access-note">
            Confirm this change with a new authenticator code or your passkey.
          </p>
          {action.kind === 'add-passkey' && (
            <label className="access-label">
              Passkey name
              <input
                required
                maxLength={80}
                value={passkeyName}
                onChange={(event) => setPasskeyName(event.target.value)}
              />
            </label>
          )}
          {browser &&
          (action.kind === 'add-passkey' ||
            !inventory?.authenticator ||
            inventory?.policy === 'sso-only') ? (
            <>
              <p className="access-note">
                Confirm this change on this server's website in your browser. Sign in there and open
                Account security.
              </p>
              <button
                className="access-primary"
                disabled={busy}
                onClick={() => void browser().catch((failure) => setError(errorText(failure)))}
              >
                Open server in browser
              </button>
            </>
          ) : (
            <>
              {companySessionChange && (
                <>
                  <p className="access-note">
                    Sign in again with your company to confirm this session change.
                  </p>
                  <button
                    className="access-secondary"
                    disabled={busy}
                    onClick={() => void companyConfirm()}
                  >
                    Confirm with company login
                  </button>
                </>
              )}
              {inventory?.policy === 'mixed' && inventory.authenticator && (
                <form
                  onSubmit={(event) => {
                    event.preventDefault()
                    const code = z.string().parse(new FormData(event.currentTarget).get('code'))
                    void commit({ kind: 'totp', code })
                  }}
                >
                  <CodeField label="Authenticator code" />
                  <Primary busy={busy}>Confirm change</Primary>
                </form>
              )}
              {inventory?.policy === 'mixed' && inventory.passkeys.length > 0 && !browser && (
                <button
                  className="access-secondary"
                  disabled={busy}
                  onClick={() => void passkeyProof()}
                >
                  Confirm with passkey
                </button>
              )}
              {!companySessionChange &&
                !inventory?.authenticator &&
                !inventory?.passkeys.length &&
                (action.kind === 'add-passkey' && inventory?.policy === 'mixed' ? (
                  <>
                    <p className="access-note">
                      Sign in again with your company to confirm adding your first passkey.
                    </p>
                    <button
                      className="access-secondary"
                      disabled={busy}
                      onClick={() => {
                        setBusy(true)
                        setError('')
                        void client
                          .request(
                            '/api/auth/sign-in/oauth2',
                            z.object({ url: z.url() }),
                            {
                              providerId: 'company',
                              callbackURL: '/login?settings=security',
                              purpose: 'first-passkey',
                            },
                            lifetime.current.signal,
                          )
                          .then((result) => {
                            if (client.active && !lifetime.current.signal.aborted)
                              window.location.assign(result.url)
                          })
                          .catch((failure) => {
                            setError(errorText(failure))
                            setBusy(false)
                          })
                      }}
                    >
                      Continue with company login
                    </button>
                  </>
                ) : (
                  <p className="access-note">
                    This account has no local factor available to confirm this change.
                  </p>
                ))}
            </>
          )}
          <Alert message={error} />
        </Dialog>
      )}
    </Frame>
  )
}
function date(value: string) {
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}
