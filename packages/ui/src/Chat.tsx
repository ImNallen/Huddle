import { useEffect, useState } from 'react'
import { Workspace, type Session, type WorkspaceId } from '@huddle/contracts'
import { errorText, type Transport } from './transport'
import { Frame } from './primitives'
import { WorkspaceDialog } from './Dialogs'
import { WorkspaceView } from './WorkspaceView'

type Workspaces =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; items: Workspace[] }
export function Chat({
  client,
  session,
  onLogout,
  onServer,
  onSecurity,
}: {
  client: Transport
  session: Session
  onLogout: () => void
  onServer?: () => void
  onSecurity: () => void
}) {
  const storageKey = `huddle.workspace:${client.origin}:${session.user.id}`
  const [workspaces, setWorkspaces] = useState<Workspaces>({ kind: 'loading' })
  const [selected, setSelected] = useState<WorkspaceId | null>(null)
  const [dialog, setDialog] = useState<'create' | 'join' | null>(null)
  function load() {
    void client
      .request('/api/workspaces', Workspace.array())
      .then((items) => {
        setWorkspaces({ kind: 'ready', items })
        setSelected((current) => {
          const stored = localStorage.getItem(storageKey)
          return (
            items.find((workspace) => workspace.id === current)?.id ??
            items.find((workspace) => workspace.id === stored)?.id ??
            items[0]?.id ??
            null
          )
        })
      })
      .catch((error: unknown) => setWorkspaces({ kind: 'failed', message: errorText(error) }))
  }
  useEffect(load, [client])
  function choose(workspace: Workspace) {
    localStorage.setItem(storageKey, workspace.id)
    setSelected(workspace.id)
    setDialog(null)
    load()
  }
  const items = workspaces.kind === 'ready' ? workspaces.items : []
  const workspace = items.find((workspace) => workspace.id === selected)
  if (workspace)
    return (
      <WorkspaceView
        key={workspace.id}
        client={client}
        workspace={workspace}
        workspaces={items}
        session={session}
        onWorkspace={choose}
        onLogout={onLogout}
        onSecurity={onSecurity}
        onServer={onServer}
      />
    )
  return (
    <Frame account={session.user.email} onSignOut={onLogout} onServer={onServer} wide>
      {workspaces.kind === 'loading' ? (
        <h1 role="status">Finding your workspaces…</h1>
      ) : workspaces.kind === 'failed' ? (
        <>
          <h1>We could not load your workspaces.</h1>
          <p role="alert">{workspaces.message}</p>
          <button className="access-primary" onClick={load}>
            Try again
          </button>
        </>
      ) : (
        <>
          <h1>Choose a workspace</h1>
          <p className="access-description">
            A workspace holds your team’s rooms. Create one, or join with an invitation from a
            workspace owner.
          </p>
          <button className="access-primary" onClick={() => setDialog('create')}>
            Create a workspace
          </button>
          <button className="access-secondary" onClick={() => setDialog('join')}>
            Join with an invitation
          </button>
          <button className="access-link" onClick={onSecurity}>
            Account security
          </button>
        </>
      )}
      {dialog && (
        <WorkspaceDialog
          kind={dialog}
          client={client}
          onClose={() => setDialog(null)}
          onDone={choose}
        />
      )}
    </Frame>
  )
}
