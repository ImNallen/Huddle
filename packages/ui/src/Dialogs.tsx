import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Check, CircleAlert, Hash, Mail, Plus, TriangleAlert, X } from 'lucide-react'
import { Channel, Invitation, Room, type RoomId } from '@huddle/contracts'
import { errorText, type Transport } from './transport'
import { RequestError } from './connection'
import { sentence } from './Badges'

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
type Problem = { kind: 'member' | 'unsent' | 'failed'; message: string }
type InviteState =
  | { kind: 'editing'; problem: Problem | null }
  | { kind: 'sending' }
  | { kind: 'sent'; invitation: Invitation }
function problemOf(error: unknown): Problem {
  const status = error instanceof RequestError ? error.status : 0
  const kind = status === 409 ? 'member' : status === 503 ? 'unsent' : 'failed'
  return { kind, message: errorText(error) }
}
export function InviteDialog({
  client,
  serverName,
  onClose,
  onInvited,
}: {
  client: Transport
  serverName: string
  onClose: () => void
  onInvited: () => void
}) {
  const [state, setState] = useState<InviteState>({ kind: 'editing', problem: null })
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const email = new FormData(event.currentTarget).get('email')
    setState({ kind: 'sending' })
    try {
      const invitation = await client.request('/api/invitations', Invitation, { email })
      setState({ kind: 'sent', invitation })
      onInvited()
    } catch (failure) {
      const problem = problemOf(failure)
      setState({ kind: 'editing', problem })
      if (problem.kind === 'unsent') onInvited()
    }
  }
  if (state.kind === 'sent') {
    const { email, expiresAt } = state.invitation
    const days = Math.round((Date.parse(expiresAt) - Date.now()) / 86400000)
    return (
      <Modal
        title="Invitation sent"
        icon={
          <span className="modal-icon">
            <Check size={16} />
          </span>
        }
        description={
          <>
            <strong>{email}</strong> can now join {sentence(serverName)} The invitation expires on{' '}
            {new Date(expiresAt).toLocaleDateString([], { dateStyle: 'medium' })}.
          </>
        }
        onClose={onClose}
      >
        <p className="invite-sent">
          <Mail size={14} />
          <span>{email}</span>
          <small>
            Pending · {days} {days === 1 ? 'day' : 'days'}
          </small>
        </p>
        <div className="modal-actions">
          <button
            type="button"
            className="button"
            onClick={() => setState({ kind: 'editing', problem: null })}
          >
            <Plus size={14} />
            Invite another
          </button>
          <button type="button" className="button primary" onClick={onClose}>
            Done
          </button>
        </div>
      </Modal>
    )
  }
  const problem = state.kind === 'editing' ? state.problem : null
  return (
    <Modal
      title="Invite coworkers"
      description={`Huddle emails them an invitation to join ${sentence(serverName)} They sign in with this address to create their account. Invitations expire after 7 days; inviting the same address again sends a fresh one.`}
      onClose={onClose}
    >
      <form
        onSubmit={onSubmit}
        onInput={() => {
          if (problem) setState({ kind: 'editing', problem: null })
        }}
      >
        <label className="field">
          Email address
          <input
            name="email"
            type="email"
            placeholder="name@company.com"
            autoComplete="off"
            maxLength={254}
            required
            autoFocus
            aria-invalid={problem?.kind === 'member' || undefined}
            aria-describedby={problem ? 'invite-problem' : undefined}
          />
        </label>
        {problem && (
          <p
            id="invite-problem"
            className={`notice ${problem.kind === 'unsent' ? 'warning' : 'error'}`}
            role="alert"
          >
            {problem.kind === 'unsent' ? <TriangleAlert size={15} /> : <CircleAlert size={15} />}
            {problem.message}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={state.kind === 'sending'}>
            {state.kind === 'sending'
              ? 'Please wait…'
              : problem?.kind === 'unsent'
                ? 'Try sending again'
                : 'Send invitation'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
