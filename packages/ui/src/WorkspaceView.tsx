import { useEffect, useState } from 'react'
import {
  Home as HomeFeed,
  type ChannelId,
  type HomeItem,
  type RoomId,
  type Session,
  type Workspace,
} from '@huddle/contracts'
import { errorText, type Transport } from './transport'
import { useWorkspace } from './useWorkspace'
import { Sidebar } from './Sidebar'
import { Home } from './Home'
import { Conversation } from './Conversation'
import { ChannelDialog, InviteDialog, RoomDialog, WorkspaceDialog } from './Dialogs'

export type View = { kind: 'home' } | { kind: 'room'; roomId: RoomId; channelId: ChannelId | null }
export type Dialog =
  | { kind: 'none' }
  | { kind: 'workspace'; mode: 'create' | 'join' }
  | { kind: 'room' }
  | { kind: 'channel'; roomId: RoomId }
  | { kind: 'invite' }
export type HomeState =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; items: HomeItem[] }
export function WorkspaceView({
  client,
  workspace: listed,
  workspaces,
  session,
  onWorkspace,
  onLogout,
  onSecurity,
  onServer,
}: {
  client: Transport
  workspace: Workspace
  workspaces: Workspace[]
  session: Session
  onWorkspace: (workspace: Workspace) => void
  onLogout: () => void
  onSecurity: () => void
  onServer?: () => void
}) {
  const [view, setView] = useState<View>({ kind: 'home' })
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' })
  const [home, setHome] = useState<HomeState>({ kind: 'loading' })
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const sync = useWorkspace(
    client,
    listed,
    session.user.id,
    view.kind === 'room' ? view.channelId : null,
  )
  const snapshot = sync.state.kind === 'ready' ? sync.state.snapshot : null
  const workspace = snapshot?.workspace ?? listed
  const rooms = snapshot?.rooms ?? []
  const channels = snapshot?.channels ?? []
  if (view.kind === 'room' && !view.channelId) {
    const first = channels.find((channel) => channel.roomId === view.roomId)
    if (first) setView({ ...view, channelId: first.id })
  }
  function openRoom(roomId: RoomId) {
    setView({
      kind: 'room',
      roomId,
      channelId: channels.find((channel) => channel.roomId === roomId)?.id ?? null,
    })
  }
  async function loadHome(signal: AbortSignal) {
    try {
      await sync.settled()
      const result = await client.request(
        `/api/home?workspaceId=${listed.id}`,
        HomeFeed,
        undefined,
        signal,
      )
      if (!signal.aborted) setHome({ kind: 'ready', items: result.items })
    } catch (error) {
      if (!signal.aborted)
        setHome((current) =>
          current.kind === 'ready' ? current : { kind: 'failed', message: errorText(error) },
        )
    }
  }
  useEffect(() => {
    if (view.kind !== 'home') return
    const abort = new AbortController()
    void loadHome(abort.signal)
    return () => abort.abort()
  }, [view.kind])
  useEffect(() => {
    if (!sync.changes) return
    const abort = new AbortController()
    const timer = setTimeout(() => void loadHome(abort.signal), 300)
    return () => {
      clearTimeout(timer)
      abort.abort()
    }
  }, [sync.changes])
  const room = view.kind === 'room' ? rooms.find((room) => room.id === view.roomId) : undefined
  const channel =
    view.kind === 'room' ? channels.find((channel) => channel.id === view.channelId) : undefined
  return (
    <div className="app">
      <Sidebar
        client={client}
        session={session}
        workspace={workspace}
        workspaces={workspaces}
        rooms={rooms}
        channels={channels}
        unread={sync.unread}
        homeCount={home.kind === 'ready' ? home.items.length : 0}
        view={view}
        connection={sync.connection}
        onView={setView}
        onRoom={openRoom}
        onDialog={setDialog}
        onWorkspace={onWorkspace}
        onSecurity={onSecurity}
        onLogout={onLogout}
        onServer={onServer}
      />
      {sync.state.kind === 'loading' ? (
        <main className="main center-state">
          <p>Loading your workspace…</p>
        </main>
      ) : sync.state.kind === 'failed' ? (
        <main className="main center-state">
          <p role="alert">{sync.state.message}</p>
          <button className="button" onClick={sync.retry}>
            Try again
          </button>
        </main>
      ) : view.kind === 'home' || !room ? (
        <Home
          client={client}
          session={session}
          workspace={workspace}
          rooms={rooms}
          channels={channels}
          home={home}
          onView={setView}
          onDialog={setDialog}
          onMarkAll={sync.markAllRead}
        />
      ) : (
        <Conversation
          key={room.id}
          client={client}
          session={session}
          workspace={workspace}
          room={room}
          channel={channel}
          sync={sync}
          draft={channel ? (drafts[channel.id] ?? '') : ''}
          onDraft={(value) => {
            if (channel) setDrafts((current) => ({ ...current, [channel.id]: value }))
          }}
          onDialog={setDialog}
        />
      )}
      {dialog.kind === 'workspace' && (
        <WorkspaceDialog
          kind={dialog.mode}
          client={client}
          onClose={() => setDialog({ kind: 'none' })}
          onDone={onWorkspace}
        />
      )}
      {dialog.kind === 'room' && (
        <RoomDialog
          client={client}
          workspaceId={workspace.id}
          onClose={() => setDialog({ kind: 'none' })}
          onDone={(room) => {
            sync.include({ kind: 'room.created', room })
            setDialog({ kind: 'none' })
            setView({ kind: 'room', roomId: room.id, channelId: null })
          }}
        />
      )}
      {dialog.kind === 'channel' && (
        <ChannelDialog
          client={client}
          room={rooms.find((room) => room.id === dialog.roomId) ?? { id: dialog.roomId, name: '' }}
          onClose={() => setDialog({ kind: 'none' })}
          onDone={(channel) => {
            sync.include({ kind: 'channel.created', channel })
            setDialog({ kind: 'none' })
            setView({ kind: 'room', roomId: channel.roomId, channelId: channel.id })
          }}
        />
      )}
      {dialog.kind === 'invite' && (
        <InviteDialog
          client={client}
          workspaceId={workspace.id}
          onClose={() => setDialog({ kind: 'none' })}
        />
      )}
    </div>
  )
}
