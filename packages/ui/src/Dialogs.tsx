import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { X } from 'lucide-react'
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
  onClose,
  submit,
  children,
}: {
  title: string
  description: string
  action: string
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
            {busy ? 'Please wait…' : action}
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
      title={`Add a channel to ${room.name}`}
      description="Use lowercase letters, numbers, and hyphens."
      action="Create channel"
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
        <legend>Channel type</legend>
        {channelKinds.map((option) => (
          <label key={option.kind}>
            <input
              type="radio"
              name="kind"
              value={option.kind}
              checked={kind === option.kind}
              onChange={() => setKind(option.kind)}
            />
            <ChannelIcon kind={option.kind} size={18} />
            {option.label}
          </label>
        ))}
      </fieldset>
      <label className="field">
        Channel name
        <span className="input-icon">
          <ChannelIcon kind={kind} size={16} />
          <input
            name="name"
            placeholder={channelKinds.find((option) => option.kind === kind)?.placeholder}
            pattern={'[a-z0-9][a-z0-9\\-]{0,39}'}
            maxLength={40}
            required
            autoFocus
          />
        </span>
      </label>
    </FormDialog>
  )
}
export function NewMessageDialog({
  client,
  me,
  members,
  onClose,
  onChoose,
  onInvite,
}: {
  client: Transport
  me: Me
  members: Resource<Member[]>
  onClose: () => void
  onChoose: (userId: UserId) => Promise<void>
  onInvite: (() => void) | null
}) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const others =
    members.kind === 'ready' ? members.value.filter((member) => member.id !== me.user.id) : []
  const alone = members.kind === 'ready' && !others.length
  return (
    <Modal
      title="New message"
      description={
        alone
          ? 'There’s nobody else on this server yet. Once a friend joins, you can message them here.'
          : 'Choose who to message.'
      }
      onClose={onClose}
    >
      {members.kind === 'loading' && <p className="people-note">Loading friends…</p>}
      {members.kind === 'failed' && (
        <p className="form-error" role="alert">
          {members.message}
        </p>
      )}
      {others.length > 0 && (
        <ul className="people-list" aria-label="People">
          {others.map((member) => (
            <li key={member.id}>
              <button
                className="member-row"
                disabled={busy}
                onClick={() => {
                  setBusy(true)
                  setError('')
                  onChoose(member.id).catch((failure: unknown) => {
                    setError(errorText(failure))
                    setBusy(false)
                  })
                }}
              >
                <i className="avatar-slot" aria-hidden="true">
                  <Avatar
                    avatar={member.avatar}
                    name={member.name}
                    photo={client.photo?.bind(client)}
                    size={32}
                  />
                </i>
                <span>{member.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {alone && onInvite && (
        <div className="modal-actions">
          <button type="button" className="button primary" onClick={onInvite}>
            Share invite
          </button>
        </div>
      )}
    </Modal>
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
      title={`Share ${serverName}`}
      description="Copy this link and send it to a friend. They need access to this machine in Tailscale first. Then they open the link and confirm their name."
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
      {!invite && !problem && <p>Loading invite…</p>}
      <div className="modal-actions">
        <button type="button" className="button primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  )
}
