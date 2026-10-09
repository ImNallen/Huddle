import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Check, Copy, Hash, X } from 'lucide-react'
import { z } from 'zod'
import { Channel, Room, Workspace, type RoomId, type WorkspaceId } from '@huddle/contracts'
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
export function WorkspaceDialog({
  kind,
  client,
  onClose,
  onDone,
}: {
  kind: 'create' | 'join'
  client: Transport
  onClose: () => void
  onDone: (workspace: Workspace) => void
}) {
  return kind === 'join' ? (
    <FormDialog
      title="Join your team"
      description="Paste the one-use invitation code from a workspace owner."
      action="Join workspace"
      onClose={onClose}
      submit={async (form) =>
        onDone(
          await client.request('/api/invitations/redeem', Workspace, {
            code: String(form.get('code')).trim(),
          }),
        )
      }
    >
      <label className="field">
        Invitation code
        <input name="code" required autoFocus autoComplete="off" />
      </label>
    </FormDialog>
  ) : (
    <FormDialog
      title="Create a workspace"
      description="A workspace holds your team’s rooms. Only people you invite can join."
      action="Create workspace"
      onClose={onClose}
      submit={async (form) =>
        onDone(await client.request('/api/workspaces', Workspace, { name: form.get('name') }))
      }
    >
      <label className="field">
        Workspace name
        <input name="name" placeholder="e.g. Harbor & Co." maxLength={60} required autoFocus />
      </label>
    </FormDialog>
  )
}
export function RoomDialog({
  client,
  workspaceId,
  onClose,
  onDone,
}: {
  client: Transport
  workspaceId: WorkspaceId
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
        onDone(await client.request('/api/rooms', Room, { workspaceId, name: form.get('name') }))
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
  workspaceId,
  onClose,
}: {
  client: Transport
  workspaceId: WorkspaceId
  onClose: () => void
}) {
  const [invitation, setInvitation] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    const abort = new AbortController()
    client
      .request(
        '/api/invitations',
        z.object({ code: z.string(), expiresAt: z.string() }),
        { workspaceId },
        abort.signal,
      )
      .then((result) => setInvitation(result.code))
      .catch((failure: unknown) => {
        if (!abort.signal.aborted) setError(errorText(failure))
      })
    return () => abort.abort()
  }, [client, workspaceId])
  return (
    <Modal
      title="Invite coworkers"
      description="Share this invitation with one coworker. It can be used once and expires in 24 hours."
      onClose={onClose}
    >
      {!invitation && !error && <p className="modal-note">Creating your invitation…</p>}
      {invitation && (
        <>
          <label className="field">
            Invitation code
            <input readOnly value={invitation} onFocus={(event) => event.target.select()} />
          </label>
          <div className="modal-actions">
            <button
              className="button primary"
              onClick={() => {
                void navigator.clipboard
                  .writeText(invitation)
                  .then(() => setCopied(true))
                  .catch((failure: unknown) => setError(errorText(failure)))
              }}
            >
              {copied ? <Check size={15} /> : <Copy size={15} />}
              {copied ? 'Copied' : 'Copy invitation'}
            </button>
          </div>
        </>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  )
}
