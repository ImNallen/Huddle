import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Hash, X } from 'lucide-react'
import { Channel, Invitation, Room, type RoomId } from '@huddle/contracts'
import { errorText, type Transport } from './transport'

function Modal({
  title,
  description,
  onClose,
  children,
}: {
  title: string
  description: string
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
export function InviteDialog({
  client,
  serverName,
  onClose,
}: {
  client: Transport
  serverName: string
  onClose: () => void
}) {
  const [sent, setSent] = useState<Invitation | null>(null)
  if (sent)
    return (
      <Modal
        title="Invitation sent"
        description={`${sent.email} can now join ${serverName}. The invitation expires on ${new Date(sent.expiresAt).toLocaleDateString([], { dateStyle: 'long' })}.`}
        onClose={onClose}
      >
        <div className="modal-actions">
          <button type="button" className="button" onClick={() => setSent(null)}>
            Invite someone else
          </button>
          <button type="button" className="button primary" onClick={onClose}>
            Done
          </button>
        </div>
      </Modal>
    )
  return (
    <FormDialog
      title="Invite coworkers"
      description={`Huddle emails them an invitation to join ${serverName}. They sign in with this address to create their account. Invitations expire after 7 days; inviting the same address again sends a fresh one.`}
      action="Send invitation"
      onClose={onClose}
      submit={async (form) =>
        setSent(await client.request('/api/invitations', Invitation, { email: form.get('email') }))
      }
    >
      <label className="field">
        Work email
        <input
          name="email"
          type="email"
          placeholder="name@company.com"
          autoComplete="off"
          maxLength={254}
          required
          autoFocus
        />
      </label>
    </FormDialog>
  )
}
