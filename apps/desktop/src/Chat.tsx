import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  ArrowDown,
  ArrowRight,
  Check,
  CheckCheck,
  ChevronDown,
  Copy,
  Hash,
  LogOut,
  MessageSquare,
  Plus,
  Send,
  Server,
  Users,
  X,
} from 'lucide-react'
import { z } from 'zod'
import { Channel, Workspace, type Session } from '@huddle/contracts'
import { Client, errorText } from './client'
import { useWorkspace } from './useWorkspace'

type Workspaces =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; items: Workspace[] }
type Dialog = { kind: 'none' } | { kind: 'workspace' } | { kind: 'join' }
export function Chat({
  client,
  session,
  onLogout,
  onServer,
}: {
  client: Client
  session: Session
  onLogout: () => void
  onServer: () => void
}) {
  const [workspaces, setWorkspaces] = useState<Workspaces>({ kind: 'loading' })
  const [selected, setSelected] = useState<Workspace | null>(null)
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  function load() {
    setWorkspaces({ kind: 'loading' })
    void client
      .request('/api/workspaces', Workspace.array())
      .then((items) => {
        setWorkspaces({ kind: 'ready', items })
        setSelected(
          (current) => items.find((workspace) => workspace.id === current?.id) ?? items[0] ?? null,
        )
      })
      .catch((error: unknown) => setWorkspaces({ kind: 'failed', message: errorText(error) }))
  }
  useEffect(load, [client])
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    const form = new FormData(event.currentTarget)
    try {
      const workspace =
        dialog.kind === 'join'
          ? await client.request('/api/invitations/redeem', Workspace, {
              code: String(form.get('code')).trim(),
            })
          : await client.request('/api/workspaces', Workspace, { name: form.get('name') })
      setSelected(workspace)
      setDialog({ kind: 'none' })
      load()
    } catch (error) {
      setError(errorText(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="shell">
      <nav className="server-rail" aria-label="Workspaces">
        <div className="app-mark" title="Huddle">
          <MessageSquare size={24} strokeWidth={2.7} />
        </div>
        <div className="rail-divider" />
        {workspaces.kind === 'ready' &&
          workspaces.items.map((workspace) => (
            <button
              key={workspace.id}
              className={`workspace-icon ${workspace.id === selected?.id ? 'active' : ''}`}
              title={workspace.name}
              aria-label={workspace.name}
              aria-pressed={workspace.id === selected?.id}
              onClick={() => setSelected(workspace)}
            >
              {workspace.name.slice(0, 2).toUpperCase()}
            </button>
          ))}
        <button
          className="workspace-icon add"
          aria-label="Create workspace"
          title="Create workspace"
          onClick={() => {
            setDialog({ kind: 'workspace' })
            setError('')
          }}
        >
          <Plus size={23} />
        </button>
        <button
          className="workspace-icon add"
          aria-label="Join workspace"
          title="Join with invitation"
          onClick={() => {
            setDialog({ kind: 'join' })
            setError('')
          }}
        >
          <Users size={20} />
        </button>
        <div className="rail-bottom">
          <button
            className="icon-button"
            aria-label="Server settings"
            title="Server settings"
            onClick={onServer}
          >
            <Server size={20} />
          </button>
        </div>
      </nav>
      {selected ? (
        <WorkspaceView
          key={selected.id}
          client={client}
          workspace={selected}
          session={session}
          onLogout={onLogout}
        />
      ) : (
        <main className="workspace-empty">
          <div className="empty-orbit">
            <MessageSquare size={36} />
          </div>
          {workspaces.kind === 'loading' ? (
            <h1 role="status">Finding your workspaces…</h1>
          ) : workspaces.kind === 'failed' ? (
            <>
              <h1>We could not load your workspaces.</h1>
              <p role="alert">{workspaces.message}</p>
              <button className="primary" onClick={load}>
                Try again
              </button>
            </>
          ) : (
            <>
              <p className="eyebrow">WELCOME TO HUDDLE</p>
              <h1>Your team starts here.</h1>
              <p>
                Create a private workspace for your team,
                <br />
                or join one with an invitation from a colleague.
              </p>
              <div className="button-row">
                <button className="primary" onClick={() => setDialog({ kind: 'workspace' })}>
                  <Plus size={17} />
                  Create a workspace
                </button>
                <button className="secondary" onClick={() => setDialog({ kind: 'join' })}>
                  Join with an invitation
                </button>
              </div>
            </>
          )}
          <button className="text-button empty-logout" onClick={onLogout}>
            Sign out of {session.user.name}
          </button>
        </main>
      )}
      {dialog.kind !== 'none' && (
        <Modal
          title={dialog.kind === 'join' ? 'Join your team' : 'A home for your team'}
          onClose={() => setDialog({ kind: 'none' })}
        >
          <p>
            {dialog.kind === 'join'
              ? 'Paste the one-use invitation code from a workspace owner.'
              : 'Give your workspace a name. Only people you invite can join.'}
          </p>
          <form onSubmit={submit}>
            {dialog.kind === 'join' ? (
              <label>
                Invitation code
                <input name="code" required autoFocus autoComplete="off" />
              </label>
            ) : (
              <label>
                Workspace name
                <input
                  name="name"
                  placeholder="e.g. Design studio"
                  maxLength={60}
                  required
                  autoFocus
                />
              </label>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <button className="primary" disabled={busy}>
              {busy
                ? 'Please wait…'
                : dialog.kind === 'join'
                  ? 'Join workspace'
                  : 'Create workspace'}
              <ArrowRight size={16} />
            </button>
          </form>
        </Modal>
      )}
    </div>
  )
}
function WorkspaceView({
  client,
  workspace,
  session,
  onLogout,
}: {
  client: Client
  workspace: Workspace
  session: Session
  onLogout: () => void
}) {
  const sync = useWorkspace(client, workspace, session.user.id)
  const [dialog, setDialog] = useState<'none' | 'channel' | 'invite'>('none')
  const [invitation, setInvitation] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [more, setMore] = useState(true)
  const bottom = useRef<HTMLDivElement>(null)
  const channels = sync.state.kind === 'ready' ? sync.state.snapshot.channels : []
  const channel = channels.find((channel) => channel.id === sync.selected)
  const messages = sync.messages.filter((message) => message.channelId === sync.selected)
  const pending = sync.pending.filter((message) => message.channelId === sync.selected)
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, pending.length, sync.selected])
  useEffect(() => setMore(true), [sync.selected])
  async function createChannel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const created = await client.request('/api/channels', Channel, {
        workspaceId: workspace.id,
        name: new FormData(event.currentTarget).get('name'),
      })
      sync.setSelected(created.id)
      setDialog('none')
    } catch (error) {
      setError(errorText(error))
    } finally {
      setBusy(false)
    }
  }
  async function invite() {
    setDialog('invite')
    setInvitation(null)
    setError('')
    setBusy(true)
    try {
      const result = await client.request(
        '/api/invitations',
        z.object({ code: z.string(), expiresAt: z.string() }),
        { workspaceId: workspace.id },
      )
      setInvitation(result.code)
    } catch (error) {
      setError(errorText(error))
    } finally {
      setBusy(false)
    }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!channel) return
    const body = (drafts[channel.id] ?? '').trim()
    if (!body) return
    void sync.send({ retryId: crypto.randomUUID(), channelId: channel.id, body })
    setDrafts((current) => ({ ...current, [channel.id]: '' }))
  }
  async function older() {
    try {
      setMore((await sync.older()) === 100)
    } catch (error) {
      setError(errorText(error))
    }
  }
  return (
    <>
      <aside className="channel-sidebar">
        <header className="workspace-header">
          <div>
            <span className="eyebrow">WORKSPACE</span>
            <h2>{workspace.name}</h2>
          </div>
          <ChevronDown size={17} />
        </header>
        <div className="workspace-summary">
          <span className="workspace-badge">
            <MessageSquare size={16} />
          </span>
          <div>
            <strong>A space to connect</strong>
            <span>Keep the conversation going.</span>
          </div>
        </div>
        <div className="channel-label">
          <span>TEXT CHANNELS</span>
          {workspace.role === 'owner' && (
            <button
              className="icon-button"
              title="Create channel"
              aria-label="Create channel"
              onClick={() => {
                setDialog('channel')
                setError('')
              }}
            >
              <Plus size={16} />
            </button>
          )}
        </div>
        <nav className="channel-list" aria-label="Text channels">
          {channels.map((channel) => (
            <button
              key={channel.id}
              className={channel.id === sync.selected ? 'selected' : ''}
              onClick={() => sync.setSelected(channel.id)}
              aria-current={channel.id === sync.selected ? 'page' : undefined}
            >
              <Hash size={19} />
              <span>{channel.name}</span>
              {channel.id === sync.selected && <span className="channel-active-dot" />}
            </button>
          ))}
          {sync.state.kind === 'ready' && !channels.length && (
            <p className="sidebar-note">
              No channels yet.
              <br />
              {workspace.role === 'owner'
                ? 'Create the first one above.'
                : 'Ask an owner to create one.'}
            </p>
          )}
        </nav>
        {workspace.role === 'owner' && (
          <button className="invite-card" onClick={() => void invite()}>
            <Users size={19} />
            <span>
              <strong>Better together</strong>
              <small>Invite your teammates</small>
            </span>
            <Plus size={17} />
          </button>
        )}
        <footer className="account-bar">
          <div className="avatar self">
            {session.user.name.slice(0, 2).toUpperCase()}
            <i />
          </div>
          <div className="account-name">
            <strong>{session.user.name}</strong>
            <span>{workspace.role === 'owner' ? 'Workspace owner' : 'Team member'}</span>
          </div>
          <button className="icon-button" title="Sign out" aria-label="Sign out" onClick={onLogout}>
            <LogOut size={17} />
          </button>
        </footer>
      </aside>
      <main className="conversation">
        <header className="conversation-header">
          <div className="channel-heading">
            <Hash size={25} />
            <strong>{channel?.name ?? 'Your workspace'}</strong>
            <span className="header-separator" />
            <span className="channel-subtitle">A little room for good ideas.</span>
          </div>
          <div
            className={`connection-status ${sync.connection === 'Connected' ? 'online' : ''}`}
            role="status"
          >
            <span />
            {sync.connection}
          </div>
        </header>
        {sync.state.kind === 'loading' ? (
          <div className="center-state" role="status">
            Loading your workspace…
          </div>
        ) : sync.state.kind === 'failed' ? (
          <div className="center-state">
            <p role="alert">{sync.state.message}</p>
            <button className="secondary" onClick={sync.retry}>
              Try again
            </button>
          </div>
        ) : !channel ? (
          <div className="center-state">
            <div className="empty-orbit">
              <Hash size={34} />
            </div>
            <h2>Every conversation needs a place.</h2>
            <p>
              {workspace.role === 'owner'
                ? 'Create a text channel to start talking with your team.'
                : 'Your workspace owner can create the first channel.'}
            </p>
            {workspace.role === 'owner' && (
              <button className="primary" onClick={() => setDialog('channel')}>
                <Plus size={16} />
                Create a channel
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="message-scroll">
              <section className="channel-welcome">
                <div className="channel-symbol">
                  <Hash size={29} />
                </div>
                <p className="eyebrow">THE START OF SOMETHING GOOD</p>
                <h1>Welcome to #{channel.name}</h1>
                <p>
                  This is your team's place for{' '}
                  {channel.name === 'general' ? 'everyday conversations' : 'the conversation'}. Say
                  hello, share an idea, or ask a question.
                </p>
                <div className="welcome-rule" />
              </section>
              {sync.historyState === 'loading' && (
                <p className="history-note" role="status">
                  Loading conversation…
                </p>
              )}
              {sync.historyState === 'failed' && (
                <p className="error history-note" role="alert">
                  {sync.historyError}{' '}
                  <button className="text-button" onClick={sync.retry}>
                    Try again
                  </button>
                </p>
              )}
              {messages.length >= 100 && more && (
                <button className="older-button" onClick={() => void older()}>
                  <ArrowDown size={14} />
                  Load earlier messages
                </button>
              )}
              {sync.queueError && (
                <p role="alert" className="error history-note">
                  {sync.queueError}
                </p>
              )}
              {error && dialog === 'none' && (
                <p role="alert" className="error history-note">
                  {error}
                </p>
              )}
              {messages.map((message) => (
                <article className="message" key={message.id}>
                  <div className={`avatar ${message.authorId === session.user.id ? 'self' : ''}`}>
                    {message.authorName.slice(0, 2).toUpperCase()}
                  </div>
                  <div className="message-content">
                    <div className="message-meta">
                      <strong>{message.authorName}</strong>
                      {message.authorId === session.user.id && (
                        <span className="you-badge">you</span>
                      )}
                      <time
                        dateTime={message.createdAt}
                        title={new Date(message.createdAt).toLocaleString()}
                      >
                        {new Date(message.createdAt).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </time>
                    </div>
                    <p>{message.body}</p>
                  </div>
                </article>
              ))}
              {pending.map((message) => (
                <article className={`message pending ${message.kind}`} key={message.retryId}>
                  <div className="avatar self">{session.user.name.slice(0, 2).toUpperCase()}</div>
                  <div className="message-content">
                    <div className="message-meta">
                      <strong>{session.user.name}</strong>
                      <span>{message.kind === 'sending' ? 'Sending…' : 'Not sent'}</span>
                    </div>
                    <p>{message.body}</p>
                    {message.kind === 'failed' && (
                      <div className="error">
                        {message.error}{' '}
                        <button className="text-button" onClick={() => void sync.send(message)}>
                          Retry
                        </button>
                      </div>
                    )}
                  </div>
                </article>
              ))}
              <div ref={bottom} />
            </div>
            <form className="composer" onSubmit={submit}>
              <label className="sr-only" htmlFor="message">
                Message #{channel.name}
              </label>
              <textarea
                id="message"
                rows={1}
                maxLength={8000}
                value={drafts[channel.id] ?? ''}
                onChange={(event) =>
                  setDrafts((current) => ({ ...current, [channel.id]: event.target.value }))
                }
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault()
                    event.currentTarget.form?.requestSubmit()
                  }
                }}
                placeholder={`Message #${channel.name}`}
              />
              <button
                aria-label="Send message"
                title="Send message"
                disabled={!(drafts[channel.id] ?? '').trim()}
              >
                <Send size={18} />
              </button>
            </form>
            <div className="composer-hint">
              <span>
                <strong>Enter</strong> to send <span>·</span> <strong>Shift + Enter</strong> for a
                new line
              </span>
              <span>
                <CheckCheck size={13} /> Messages stay with your team
              </span>
            </div>
          </>
        )}
      </main>
      {dialog !== 'none' && (
        <Modal
          title={dialog === 'channel' ? 'Create a text channel' : 'Make room for your team'}
          onClose={() => setDialog('none')}
        >
          {dialog === 'channel' ? (
            <form onSubmit={createChannel}>
              <p>Give the conversation a place. Use lowercase letters, numbers, and hyphens.</p>
              <label>
                Channel name
                <div className="input-icon">
                  <Hash size={18} />
                  <input
                    name="name"
                    placeholder="e.g. general"
                    pattern={'[a-z0-9][a-z0-9\\-]{0,39}'}
                    maxLength={40}
                    required
                    autoFocus
                  />
                </div>
              </label>
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <button className="primary" disabled={busy}>
                {busy ? 'Creating…' : 'Create channel'}
              </button>
            </form>
          ) : (
            <>
              <p>
                Share this invitation with one teammate. It can be used once and expires in 24
                hours.
              </p>
              {busy && <p role="status">Creating your invitation…</p>}
              {invitation && (
                <>
                  <label>
                    Invitation code
                    <input readOnly value={invitation} onFocus={(event) => event.target.select()} />
                  </label>
                  <button
                    className="primary"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(invitation)
                        .then(() => setCopied(true))
                        .catch((error: unknown) => setError(errorText(error)))
                    }}
                  >
                    {copied ? <Check size={17} /> : <Copy size={17} />}
                    {copied ? 'Copied' : 'Copy invitation'}
                  </button>
                </>
              )}
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
            </>
          )}
        </Modal>
      )}
    </>
  )
}
function Modal({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    ref.current?.showModal()
    return () => ref.current?.close()
  }, [])
  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      aria-labelledby="modal-title"
    >
      <button className="icon-button modal-close" aria-label="Close dialog" onClick={onClose}>
        <X size={19} />
      </button>
      <h2 id="modal-title">{title}</h2>
      {children}
    </dialog>
  )
}
