import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Hash, X } from 'lucide-react'
import { Channel, FriendInvites, Room, parseInvite, type RoomId } from '@huddle/contracts'
import { errorText, type Transport } from './transport'
import { CopyButton } from './primitives'

function Modal({
  title,
  description,
  icon,
  onClose,
  children,
}: {
  title: string
  description: ReactNode
  icon?: ReactNode
  onClose: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    return () => dialog?.close()
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
        <X size={16} />
      </button>
      {icon}
      <h2 id="modal-title">{title}</h2>
      <p className="modal-description">{description}</p>
      {children}
    </dialog>
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
          <button type="button" className="button" onClick={onClose}>
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
      description="A room gathers the people and channels for one area of work, like Development or Support."
      action="Create room"
      onClose={onClose}
      submit={async (form) =>
        onDone(await client.request('/api/rooms', Room, { name: form.get('name') }))
      }
    >
      <label className="field">
        Room name
        <input name="name" placeholder="e.g. Development" maxLength={40} required autoFocus />
      </label>
    </FormDialog>
  )
}
export function ChannelDialog({
  client,
  room,
  onClose,
  onDone,
}: {
  client: Transport
  room: { id: RoomId; name: string }
  onClose: () => void
  onDone: (channel: Channel) => void
}) {
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
          }),
        )
      }
    >
      <label className="field">
        Channel name
        <span className="input-icon">
          <Hash size={15} />
          <input
            name="name"
            placeholder="e.g. code-review"
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
function inviteLabel(value: string) {
  try {
    const invite = parseInvite(value)
    const parts = invite.host.split('.').map((part) => Number(part))
    const a = parts[0]
    const b = parts[1]
    const lan =
      invite.host === '127.0.0.1' ||
      a === 10 ||
      (a === 192 && b === 168) ||
      (a === 172 && b !== undefined && b >= 16 && b <= 31) ||
      (a === 100 && b !== undefined && b >= 64 && b <= 127)
    return lan
      ? `${invite.host}:${invite.port} on this network`
      : `${invite.host}:${invite.port} from the internet`
  } catch {
    return 'Invite'
  }
}
export function InviteDialog({
  client,
  serverName,
  onClose,
  onInvited: _onInvited,
}: {
  client: Transport
  serverName: string
  onClose: () => void
  onInvited: () => void
}) {
  const [invites, setInvites] = useState<string[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    client.request('/api/friend-invite', FriendInvites).then(
      (value) => {
        if (!cancelled) setInvites(value.invites)
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
      description={`Copy one invite and send it to a friend. They paste it into Huddle and choose a username. The invite locks this server, so a lookalike cannot take its place.`}
      onClose={onClose}
    >
      {problem && (
        <p className="notice error" role="alert">
          {problem}
        </p>
      )}
      {invites?.length === 0 && (
        <p className="notice warning">
          This server has no address to share yet. Friends on another network cannot connect until
          this computer is reachable.
        </p>
      )}
      {invites?.map((invite) => (
        <p className="invite-sent" key={invite}>
          <span>{inviteLabel(invite)}</span>
          <CopyButton value={invite} label="Copy invite" />
        </p>
      ))}
      {!invites && !problem && <p>Loading invites…</p>}
      <div className="modal-actions">
        <button type="button" className="button primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  )
}
