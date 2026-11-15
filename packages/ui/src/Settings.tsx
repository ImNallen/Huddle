import { useCallback, useEffect, useRef, useState } from 'react'
import type { z } from 'zod'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import {
  Account,
  type AccessCommand,
  type AccessStage,
  type MemberRole,
  type Profile,
  type PublicUser,
} from '@huddle/contracts'
import { Alert, Logo, Overlay } from './primitives'
import { Avatar, ProfileEditor } from './Avatar'
import { AppearanceTab } from './appearance/Appearance'
import { useAppearance, type Mode } from './appearance/store'
import { HUDDLE_ID } from './appearance/builtins'
import { VoiceTab } from './VoiceTab'
import type { Connection } from './connection'
import { errorText } from './transport'

const tabKeys = ['profile', 'appearance', 'voice', 'connection'] as const
const tabs = {
  profile: {
    title: 'Profile',
    description: 'Your name and avatar are shared across this server.',
  },
  appearance: {
    title: 'Appearance',
    description: 'How Huddle looks on this device.',
  },
  voice: {
    title: 'Voice',
    description: 'How you sound and what you hear on this device.',
  },
  connection: {
    title: 'Connection',
    description: 'Tailscale says who you are. Huddle keeps nothing to sign in with.',
  },
}
type Tab = keyof typeof tabs
const modeLabels: Record<Mode, string> = { system: 'System', light: 'Light', dark: 'Dark' }

export function Settings({
  client,
  serverName,
  role,
  user,
  accept,
  close,
}: {
  client: Connection
  serverName: string
  role?: MemberRole
  user: PublicUser
  accept: (stage: AccessStage) => void
  close: () => void
}) {
  const { mode, selected, scheme } = useAppearance()
  const [account, setAccount] = useState<z.infer<typeof Account> | null>(null)
  // null is the list of tabs, which only a window narrower than 640px shows.
  const [opened, setOpened] = useState<Tab | null>(null)
  const tab = opened ?? 'profile'
  const photo = useCallback((id: string, signal: AbortSignal) => client.photo(id, signal), [client])
  const back = useRef<HTMLButtonElement>(null)
  const rows = useRef(new Map<Tab, HTMLButtonElement>())
  const previous = useRef<Tab | null>(null)
  useEffect(() => {
    // The pressed control disappears when the list and a tab swap places.
    if (opened) back.current?.focus()
    else if (previous.current) rows.current.get(previous.current)?.focus()
    previous.current = opened
  }, [opened])
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
  const values: Partial<Record<Tab, string>> = {
    appearance: modeLabels[mode],
    connection: account ? 'Online' : error ? 'Offline' : undefined,
  }
  return (
    <Overlay
      className={`settings ${opened ? 'is-tab' : 'is-list'}`}
      labelledBy="settings-label"
      onClose={close}
    >
      <section className="settings-home">
        <div className="settings-top">
          <button className="settings-back" aria-label="Close settings" onClick={close}>
            <ChevronLeft size={24} aria-hidden="true" />
          </button>
          <div>
            <span>Settings</span>
            <span>{serverName}</span>
          </div>
        </div>
        <div className="settings-home-scroll">
          <div className="settings-identity">
            <Avatar avatar={user.avatar} name={user.name} photo={photo} size={64} />
            <div>
              <strong>{user.name}</strong>
              <span>
                {role === 'admin'
                  ? `Admin of ${serverName}`
                  : role === 'member'
                    ? `Member of ${serverName}`
                    : serverName}
              </span>
            </div>
          </div>
          <nav className="settings-rows" aria-label="Settings">
            {tabKeys.map((key) => (
              <button
                key={key}
                ref={(row) => {
                  if (row) rows.current.set(key, row)
                  else rows.current.delete(key)
                }}
                onClick={() => setOpened(key)}
              >
                <span>{tabs[key].title}</span>
                {values[key] && <span>{values[key]}</span>}
                <ChevronRight size={18} aria-hidden="true" />
              </button>
            ))}
          </nav>
          <p className="settings-home-note">
            Huddle signs you in through Tailscale, so there is no password to manage here.
          </p>
        </div>
      </section>
      <aside className="settings-side">
        <span id="settings-label" className="settings-label">
          Settings
        </span>
        <nav className="settings-nav" aria-label="Settings">
          {tabKeys.map((key) => (
            <button
              key={key}
              aria-current={tab === key ? 'page' : undefined}
              onClick={() => setOpened(key)}
            >
              {tabs[key].title}
            </button>
          ))}
        </nav>
        <div className="settings-server">
          <Logo size={24} />
          <span>{serverName}</span>
        </div>
      </aside>
      <div className="settings-main">
        <div className="settings-bar">
          <button
            ref={back}
            className="settings-back"
            aria-label="Back to settings"
            onClick={() => setOpened(null)}
          >
            <ChevronLeft size={24} aria-hidden="true" />
          </button>
          <h1>{tabs[tab].title}</h1>
          <span className="settings-bar-sub">Settings</span>
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
          <div className={`settings-content settings-${tab}`}>
            <p className="access-description">
              {tab === 'connection' ? `Your connection to ${serverName}.` : tabs[tab].description}
            </p>
            {tab === 'appearance' ? (
              <AppearanceTab />
            ) : tab === 'voice' ? (
              <VoiceTab />
            ) : !account ? (
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
                  context={{ kind: 'settings', serverName }}
                />
                <Alert message={error} />
              </>
            ) : (
              <>
                <div
                  className={`connection-status ${selected[scheme] === HUDDLE_ID ? 'is-huddle' : ''}`}
                >
                  <i aria-hidden="true" />
                  <div>
                    <strong>Connected through Tailscale</strong>
                    <span>{account.login}</span>
                  </div>
                </div>
                <section className="connection-explanation">
                  <h2>Your Tailscale identity is your connection.</h2>
                  <p>{tabs.connection.description}</p>
                  <p>There's no sign-in and nothing to sign out of.</p>
                </section>
                <section className="connection-leave">
                  <h2>To leave</h2>
                  <p>Disconnect Tailscale on this device.</p>
                </section>
                <p className="settings-footnote">
                  Your login is visible only to you and server admins.
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </Overlay>
  )
}
