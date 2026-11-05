import { useEffect, useRef, useState } from 'react'
import type { z } from 'zod'
import { X } from 'lucide-react'
import { Account, type AccessCommand, type AccessStage, type Profile } from '@huddle/contracts'
import { Alert, Overlay } from './primitives'
import { ProfileEditor } from './Avatar'
import type { Connection } from './connection'
import { errorText } from './transport'

const tabs = {
  profile: {
    title: 'Profile',
    description: 'Your name and avatar are shared across this server.',
  },
  connection: {
    title: 'Connection',
    description: 'Tailscale says who you are. Huddle keeps nothing to sign in with.',
  },
}
type Tab = keyof typeof tabs

export function Settings({
  client,
  accept,
  close,
}: {
  client: Connection
  accept: (stage: AccessStage) => void
  close: () => void
}) {
  const [account, setAccount] = useState<z.infer<typeof Account> | null>(null)
  const [tab, setTab] = useState<Tab>('profile')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const lifetime = useRef(new AbortController())
  useEffect(() => {
    const abort = new AbortController()
    lifetime.current = abort
    void client.request('/api/account', Account, undefined, abort.signal).then(
      (value) => {
        if (!abort.signal.aborted) setAccount(value)
      },
      (failure: unknown) => {
        if (!abort.signal.aborted) setError(errorText(failure))
      },
    )
    return () => abort.abort()
  }, [client])
  async function reload() {
    const signal = lifetime.current.signal
    const value = await client.request('/api/account', Account, undefined, signal)
    if (!signal.aborted) setAccount(value)
  }
  async function apply(command: AccessCommand) {
    setBusy(true)
    setError('')
    const signal = lifetime.current.signal
    try {
      accept(await client.act(command))
      if (!signal.aborted) await reload()
    } catch (failure) {
      if (!signal.aborted) setError(errorText(failure))
    } finally {
      if (!signal.aborted) setBusy(false)
    }
  }
  return (
    <Overlay className="settings" labelledBy="settings-label" onClose={close}>
      <aside className="settings-side">
        <span id="settings-label" className="settings-label">
          Settings
        </span>
        <nav className="settings-nav" aria-label="Settings">
          {(Object.keys(tabs) as Tab[]).map((key) => (
            <button
              key={key}
              aria-current={tab === key ? 'page' : undefined}
              onClick={() => setTab(key)}
            >
              {tabs[key].title}
            </button>
          ))}
        </nav>
      </aside>
      <div className="settings-main">
        <div className="settings-bar">
          <h1>{tabs[tab].title}</h1>
          <button
            className="icon-button"
            aria-label="Close settings"
            title="Close settings"
            onClick={close}
          >
            <X size={18} />
          </button>
        </div>
        <div className="settings-scroll">
          <div className="settings-content">
            <p className="access-description">{tabs[tab].description}</p>
            {!account ? (
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
                  initial={{ name: account.user.name, avatar: account.user.avatar }}
                  save={(profile: Profile) => apply({ kind: 'profile.save', profile })}
                  busy={busy}
                  upload={(file) => client.upload(file)}
                  photo={(id, signal) => client.photo(id, signal)}
                  submitLabel="Save profile"
                />
                <Alert message={error} />
              </>
            ) : (
              <section className="access-card">
                <h2>
                  Connected as <code>{account.login}</code> through Tailscale.
                </h2>
                <p>There's no sign-in and nothing to sign out of.</p>
                <p>To leave, disconnect Tailscale on this device.</p>
              </section>
            )}
          </div>
        </div>
      </div>
    </Overlay>
  )
}
