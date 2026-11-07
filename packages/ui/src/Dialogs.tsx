import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Check, X } from 'lucide-react'
import {
  Channel,
  Room,
  ServerInvite,
  parseInvite,
  type ChannelKind,
  type Member,
  type RoomId,
  type Me,
  type UserId,
} from '@huddle/contracts'
import { errorText, type Transport } from './transport'
import { Avatar } from './Avatar'
import { ChannelIcon } from './Badges'
import type { Resource } from './Members'
import { CopyButton, Overlay, hostOf } from './primitives'

export function Modal({
  title,
  description,
  icon,
  className,
  onClose,
  children,
}: {
  title: string
  description: ReactNode
  icon?: ReactNode
  className?: string
  onClose: () => void
  children: ReactNode
}) {
  return (
    <Overlay
      className={className ? `modal ${className}` : 'modal'}
      labelledBy="modal-title"
      onClose={onClose}
    >
      <button className="icon-button modal-close" aria-label="Close dialog" onClick={onClose}>
        <X size={18} />
      </button>
      {icon}
      <h2 id="modal-title">{title}</h2>
      <p className="modal-description">{description}</p>
      {children}
    </Overlay>
  )
}
function FormDialog({
  title,
  description,
  action,
  busyLabel,
  onClose,
  submit,
  children,
}: {
  title: string
  description: string
  action: string
  busyLabel: string
  onClose: () => void
  submit: (form: FormData) => Promise<void>
  children: ReactNode
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await submit(new FormData(event.currentTarget))
    } catch (failure) {
      setError(errorText(failure))
      setBusy(false)
    }
  }
  return (
    <Modal title={title} description={description} onClose={onClose}>
      <form onSubmit={onSubmit}>
        {children}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="button text" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? busyLabel : action}
          </button>
        </div>
      </form>
    </Modal>
  )
}
export function RoomDialog({
  client,
  onClose,
  onDone,
}: {
  client: Transport
  onClose: () => void
  onDone: (room: Room) => void
}) {
  return (
    <FormDialog
      title="Create a room"
      description="A room gathers the channels for one group or topic, like Gaming or Book Club."
      action="Create room"
      busyLabel="Creating your room…"
      onClose={onClose}
      submit={async (form) =>
        onDone(await client.request('/api/rooms', Room, { name: form.get('name') }))
      }
    >
      <label className="field">
        Room name
        <input name="name" placeholder="e.g. Gaming" maxLength={40} required autoFocus />
      </label>
    </FormDialog>
  )
}
const channelKinds: { kind: ChannelKind; label: string; placeholder: string }[] = [
  { kind: 'text', label: 'Text', placeholder: 'e.g. code-review' },
  { kind: 'voice', label: 'Voice', placeholder: 'e.g. hangout' },
]
export function ChannelDialog({
  client,
  room,
  initialKind,
  onClose,
  onDone,
}: {
  client: Transport
  room: { id: RoomId; name: string }
  initialKind: ChannelKind
  onClose: () => void
  onDone: (channel: Channel) => void
}) {
  const [kind, setKind] = useState(initialKind)
  return (
    <FormDialog
      title="Add a channel"
      description={`In ${room.name}. Choose how people will talk here.`}
      action="Create channel"
      busyLabel="Creating your channel…"
      onClose={onClose}
      submit={async (form) =>
        onDone(
          await client.request('/api/channels', Channel, {
            roomId: room.id,
            name: form.get('name'),
            kind,
          }),
        )
      }
    >
      <fieldset className="kind-options">
        <legend className="sr-only">Channel type</legend>
        {channelKinds.map((option) => (
          <label key={option.kind}>
            <input
              type="radio"
              aria-label={option.label}
              name="kind"
              value={option.kind}
              checked={kind === option.kind}
              onChange={() => setKind(option.kind)}
            />
            <ChannelIcon kind={option.kind} size={18} />
            <strong>{option.label}</strong>
            {kind === option.kind && <Check className="kind-check" size={16} />}
            <span>{option.kind === 'text' ? 'Messages, at your pace' : 'A place to drop in'}</span>
          </label>
        ))}
      </fieldset>
      <label className="field">
        Channel name
        <input
          name="name"
          placeholder={channelKinds.find((option) => option.kind === kind)?.placeholder}
          pattern={'[a-z0-9][a-z0-9\\-]{0,39}'}
          maxLength={40}
          required
          autoFocus
        />
      </label>
      <p className="field-hint">Use lowercase letters, numbers, and hyphens.</p>
    </FormDialog>
  )
}
export function NewMessageDialog({
  client,
  me,
  serverName,
  members,
  onClose,
  onChoose,
  onGroup,
  onInvite,
}: {
  client: Transport
  me: Me
  serverName: string
  members: Resource<Member[]>
  onClose: () => void
  onGroup: () => void
  onChoose: (userId: UserId) => Promise<void>
  onInvite: (() => void) | null
}) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState<UserId | null>(null)
  const search = useRef<HTMLInputElement>(null)
  const others =
    members.kind === 'ready' ? members.value.filter((member) => member.id !== me.user.id) : []
  const alone = members.kind === 'ready' && !others.length
  const filtered = others.filter((member) =>
    member.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  )
  const active = filtered.find((member) => member.id === activeId) ?? filtered[0]
  useEffect(() => {
    if (members.kind === 'ready') search.current?.focus()
  }, [members.kind])
  function choose(userId: UserId) {
    if (busy) return
    setBusy(true)
    setError('')
    onChoose(userId).catch((failure: unknown) => {
      setError(errorText(failure))
      setBusy(false)
      requestAnimationFrame(() => search.current?.focus())
    })
  }
  function move(direction: -1 | 1) {
    if (!filtered.length) return
    const index = Math.max(
      0,
      filtered.findIndex((member) => member.id === active?.id),
    )
    const next = filtered[(index + direction + filtered.length) % filtered.length]
    if (!next) return
    setActiveId(next.id)
    document.getElementById(`direct-person-${next.id}`)?.scrollIntoView({ block: 'nearest' })
  }
  return (
    <Overlay className="modal new-message" labelledBy="new-message-title" onClose={onClose}>
      <header className="new-message-header">
        <h2 id="new-message-title">New message</h2>
        <button className="new-message-cancel" onClick={onClose}>
          Cancel
        </button>
      </header>
      <p className="new-message-description">
        {alone
          ? 'There’s nobody else on this server yet. Once a friend joins, you can message them here.'
          : `Choose someone in ${serverName}.`}
      </p>
      <label className="sr-only" htmlFor="find-person">
        Find a person
      </label>
      <input
        ref={search}
        id="find-person"
        role="combobox"
        type="search"
        autoComplete="off"
        placeholder="Find a person…"
        aria-controls="direct-people"
        aria-expanded={true}
        aria-autocomplete="list"
        aria-activedescendant={active ? `direct-person-${active.id}` : undefined}
        value={query}
        disabled={busy || members.kind !== 'ready'}
        onChange={(event) => {
          setQuery(event.target.value)
          setActiveId(null)
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            move(event.key === 'ArrowDown' ? 1 : -1)
          } else if (event.key === 'Enter' && active) {
            event.preventDefault()
            choose(active.id)
          }
        }}
      />
      {members.kind === 'loading' && (
        <p className="people-note" role="status">
          Loading friends…
        </p>
      )}
      {members.kind === 'failed' && (
        <p className="form-error" role="alert">
          {members.message}
        </p>
      )}
      <ul
        id="direct-people"
        className="people-list"
        role="listbox"
        aria-label="People"
        aria-busy={busy}
      >
        {filtered.map((member) => (
          <li key={member.id} role="presentation">
            <button
              id={`direct-person-${member.id}`}
              className="member-row"
              role="option"
              aria-selected={member.id === active?.id}
              tabIndex={-1}
              disabled={busy}
              onPointerDown={(event) => event.preventDefault()}
              onPointerMove={() => {
                if (member.id !== active?.id) setActiveId(member.id)
              }}
              onClick={() => choose(member.id)}
            >
              <i className="avatar-slot" aria-hidden="true">
                <Avatar
                  avatar={member.avatar}
                  name={member.name}
                  photo={client.photo?.bind(client)}
                  size={28}
                />
              </i>
              <span>{member.name}</span>
            </button>
          </li>
        ))}
      </ul>
      {members.kind === 'ready' && !alone && !filtered.length && (
        <p className="people-note" role="status">
          No people found. Try another name.
        </p>
      )}
      {busy && (
        <p className="people-note" role="status">
          Opening conversation…
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!alone && (
        <button className="new-group-action" disabled={busy} onClick={onGroup}>
          New group
        </button>
      )}
      {alone && onInvite && (
        <div className="modal-actions">
          <button className="button primary" onClick={onInvite}>
            Share invite
          </button>
        </div>
      )}
    </Overlay>
  )
}
export function InviteDialog({
  client,
  serverName,
  onClose,
}: {
  client: Transport
  serverName: string
  onClose: () => void
}) {
  const [invite, setInvite] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    client.request('/api/invite', ServerInvite).then(
      (value) => {
        if (!cancelled) setInvite(value.invite)
      },
      (failure: unknown) => {
        if (!cancelled) setProblem(errorText(failure))
      },
    )
    return () => {
      cancelled = true
    }
  }, [client])
  return (
    <Modal
      className="invite-dialog"
      title="Share invite"
      description={
        <>
          <span className="invite-introduction">Bring a friend to {serverName}.</span>
          They need access to this machine in Tailscale first. Then they open your invite link and
          confirm their name.
        </>
      }
      onClose={onClose}
    >
      {problem && (
        <p className="notice error" role="alert">
          {problem}
        </p>
      )}
      {invite && (
        <p className="invite-sent">
          <span>{hostOf(parseInvite(invite).origin)}</span>
          <CopyButton value={invite} label="Copy invite" />
        </p>
      )}
      {!invite && !problem && (
        <div className="invite-loading" role="status">
          <strong>Loading invite…</strong>
          <p>Your invite link will appear here.</p>
        </div>
      )}
      <div className="modal-actions">
        <button type="button" className="button primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  )
}
