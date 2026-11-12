import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Check, X } from 'lucide-react'
import { z } from 'zod'
import {
  Channel,
  Cursor,
  Room,
  ServerInvite,
  TEXT_CHANNEL_NAME_PATTERN,
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
import { channelLabel } from './useServer'
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
  ready = true,
  danger = false,
  onClose,
  submit,
  children,
}: {
  title: string
  description: string
  action: string
  busyLabel: string
  ready?: boolean
  danger?: boolean
  onClose: () => void
  submit: (form: FormData) => Promise<void>
  children?: ReactNode
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
          <button className={`button ${danger ? 'danger' : 'primary'}`} disabled={busy || !ready}>
            {busy ? busyLabel : action}
          </button>
        </div>
      </form>
    </Modal>
  )
}
const CreatedRoom = Room.extend({ cursor: Cursor })
const CreatedChannel = Channel.extend({ cursor: Cursor })
export function RoomDialog({
  client,
  onClose,
  onDone,
}: {
  client: Transport
  onClose: () => void
  onDone: (room: Room, cursor: string) => void
}) {
  return (
    <FormDialog
      title="Create a room"
      description="A room gathers the channels for one group or topic, like Gaming or Book Club."
      action="Create room"
      busyLabel="Creating your room…"
      onClose={onClose}
      submit={async (form) => {
        const { cursor, ...room } = await client.request('/api/rooms', CreatedRoom, {
          name: form.get('name'),
        })
        onDone(room, cursor)
      }}
    >
      <label className="field">
        Room name
        <input name="name" placeholder="e.g. Gaming" maxLength={40} required autoFocus />
      </label>
    </FormDialog>
  )
}
export type Renamable =
  | { kind: 'server'; name: string }
  | { kind: 'room'; room: Room; channels: Channel[] }
  | { kind: 'channel'; channel: Channel }
export type Deletable = Exclude<Renamable, { kind: 'server' }>
const Done = z.object({})
function renaming(target: Renamable) {
  switch (target.kind) {
    case 'server':
      return {
        noun: 'server',
        name: target.name,
        field: 'Server name',
        maxLength: 60,
        text: false,
        path: '/api/server/rename',
        body: (name: string) => ({ name }),
      }
    case 'room':
      return {
        noun: 'room',
        name: target.room.name,
        field: 'Room name',
        maxLength: 40,
        text: false,
        path: '/api/rooms/rename',
        body: (name: string) => ({ roomId: target.room.id, name }),
      }
    case 'channel': {
      const { id, kind } = target.channel
      return {
        noun: 'channel',
        name: target.channel.name,
        field: 'Channel name',
        maxLength: 40,
        text: kind === 'text',
        path: '/api/channels/rename',
        body: (name: string) => ({ channelId: id, kind, name }),
      }
    }
  }
}
export function RenameDialog({
  client,
  target,
  onClose,
}: {
  client: Transport
  target: Renamable
  onClose: () => void
}) {
  const subject = renaming(target)
  const [name, setName] = useState(subject.name)
  return (
    <FormDialog
      title={`Rename ${subject.noun}`}
      description="Everyone sees the new name right away."
      action="Save"
      busyLabel="Saving…"
      ready={name.trim().length > 0}
      onClose={onClose}
      submit={async () => {
        await client.request(subject.path, Done, subject.body(name))
        onClose()
      }}
    >
      <label className="field">
        {subject.field}
        <input
          name="name"
          pattern={subject.text ? TEXT_CHANNEL_NAME_PATTERN : undefined}
          value={name}
          onChange={(event) =>
            setName(subject.text ? event.target.value.toLowerCase() : event.target.value)
          }
          maxLength={subject.maxLength}
          required
          autoFocus
        />
      </label>
      {subject.text && (
        <p className="field-hint">
          Use lowercase letters (including å, ä, ö), numbers, and hyphens.
        </p>
      )}
    </FormDialog>
  )
}
function deleting(target: Deletable) {
  switch (target.kind) {
    case 'room': {
      const { room, channels } = target
      const count = channels.length
      return {
        label: room.name,
        name: room.name,
        action: 'Delete room',
        lost: [
          count
            ? `This permanently deletes ${room.name} and its ${count === 1 ? 'channel' : `${count} channels`}, with every message, unread count, and mention in ${count === 1 ? 'it' : 'them'}, for everyone.`
            : `This permanently deletes ${room.name} for everyone.`,
          channels.some((channel) => channel.kind === 'voice')
            ? 'Anyone in a call there is disconnected.'
            : '',
        ],
        path: '/api/rooms/delete',
        body: (confirm: string) => ({ roomId: room.id, confirm }),
      }
    }
    case 'channel': {
      const { channel } = target
      const label = channelLabel(channel)
      return {
        label,
        name: channel.name,
        action: 'Delete channel',
        lost:
          channel.kind === 'text'
            ? [
                `This permanently deletes ${label} and every message, unread count, and mention in it, for everyone.`,
              ]
            : [
                `This permanently deletes ${label} for everyone.`,
                'Anyone in the call is disconnected.',
              ],
        path: '/api/channels/delete',
        body: (confirm: string) => ({ channelId: channel.id, confirm }),
      }
    }
  }
}
export function DeleteDialog({
  client,
  target,
  onClose,
}: {
  client: Transport
  target: Deletable
  onClose: () => void
}) {
  const subject = deleting(target)
  const [typed, setTyped] = useState('')
  return (
    <FormDialog
      title={`Delete ${subject.label}?`}
      description={[...subject.lost, 'It can’t be undone.'].filter(Boolean).join(' ')}
      action={subject.action}
      busyLabel="Deleting…"
      ready={typed === subject.name}
      danger
      onClose={onClose}
      submit={async () => {
        await client.request(subject.path, Done, subject.body(typed))
        onClose()
      }}
    >
      <label className="field">
        <span>
          Type <strong className="confirm-name">{subject.name}</strong> to confirm
        </span>
        <input
          name="confirm"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          maxLength={80}
          required
          autoFocus
        />
      </label>
    </FormDialog>
  )
}
export function RemoveMemberDialog({
  client,
  member,
  onClose,
}: {
  client: Transport
  member: Member
  onClose: () => void
}) {
  return (
    <FormDialog
      title={`Remove ${member.name}?`}
      description="They leave every room, call, and group, and their Tailscale login can’t rejoin until you unblock them. Their messages stay, under their name."
      action="Remove"
      busyLabel="Removing…"
      danger
      onClose={onClose}
      submit={async () => {
        await client.request('/api/members/remove', Done, { userId: member.id })
        onClose()
      }}
    />
  )
}
const channelKinds: { kind: ChannelKind; label: string; placeholder: string }[] = [
  { kind: 'text', label: 'Text', placeholder: 'e.g. code-review' },
  { kind: 'voice', label: 'Voice', placeholder: 'e.g. Game 1' },
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
  onDone: (channel: Channel, cursor: string) => void
}) {
  const [kind, setKind] = useState(initialKind)
  const [name, setName] = useState('')
  return (
    <FormDialog
      title="Add a channel"
      description={`In ${room.name}. Choose how people will talk here.`}
      action="Create channel"
      busyLabel="Creating your channel…"
      onClose={onClose}
      submit={async (form) => {
        const { cursor, ...channel } = await client.request('/api/channels', CreatedChannel, {
          roomId: room.id,
          name: form.get('name'),
          kind,
        })
        onDone(channel, cursor)
      }}
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
              onChange={() => {
                setKind(option.kind)
                if (option.kind === 'text') setName((name) => name.toLowerCase())
              }}
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
          pattern={kind === 'text' ? TEXT_CHANNEL_NAME_PATTERN : undefined}
          value={name}
          onChange={(event) =>
            setName(kind === 'text' ? event.target.value.toLowerCase() : event.target.value)
          }
          maxLength={40}
          required
          autoFocus
        />
      </label>
      <p className="field-hint">
        {kind === 'text'
          ? 'Use lowercase letters (including å, ä, ö), numbers, and hyphens.'
          : 'Use any name, including spaces, capitals, and emoji.'}
      </p>
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
    if (members.kind === 'ready' && !busy) search.current?.focus()
  }, [members.kind, busy])
  function choose(userId: UserId) {
    if (busy) return
    setBusy(true)
    setError('')
    onChoose(userId).catch((failure: unknown) => {
      setError(errorText(failure))
      setBusy(false)
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
