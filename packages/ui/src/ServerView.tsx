import { useEffect, useState } from 'react'
import {
  DirectConversation as DirectConversationSchema,
  type Avatar as AvatarValue,
  type ChannelId,
  type ChannelKind,
  type ConversationId,
  type Member,
  type RoomId,
  type Me,
  type UserId,
} from '@huddle/contracts'
import { GroupConversation, GroupPeopleDialog, GroupMembersDialog } from './GroupChat'
import { threadKey, type GroupThread } from './chat'
import type { Transport } from './transport'
import { useServer, type DirectThread, type Thread, type ThreadMessage } from './useServer'
import { Sidebar } from './Sidebar'
import { Home } from './Home'
import { ChannelConversation, DirectConversation } from './Conversation'
import { EmptyRoom } from './RoomViews'
import { VoiceChannel, type VoiceAvailability } from './Voice'
import { useVoiceCall } from './voiceCall'
import { ChannelDialog, InviteDialog, NewMessageDialog, RoomDialog } from './Dialogs'
import { MemberDetails, MemberList, MembersPage, useMembers } from './Members'
import { Badge } from './Badges'
import { Frame, ServerCard } from './primitives'

export type View =
  | { kind: 'home' }
  | { kind: 'members' }
  | { kind: 'room'; roomId: RoomId; channelId: ChannelId | null }
  | { kind: 'direct'; conversationId: ConversationId }
  | { kind: 'group'; thread: GroupThread }
export type Dialog =
  | { kind: 'none' }
  | { kind: 'room' }
  | { kind: 'channel'; roomId: RoomId; channelKind: ChannelKind }
  | { kind: 'invite' }
  | { kind: 'direct' }
  | { kind: 'member'; member: Member; anchor: HTMLButtonElement }
  | { kind: 'new-group' }
  | { kind: 'group-members'; thread: GroupThread }
  | { kind: 'group-add'; thread: GroupThread }
type Peer = { name: string; avatar: AvatarValue | null | undefined }
export type DirectRow = DirectThread & { peer: Peer }
function peerOf(direct: DirectThread, roster: Member[] | null, messages: ThreadMessage[]): Peer {
  const member = roster?.find((person) => person.id === direct.peerId)
  if (member) return member
  const wrote = [direct.latest, ...messages].find((message) => message?.authorId === direct.peerId)
  return wrote
    ? { name: wrote.authorName, avatar: wrote.authorAvatar }
    : { name: 'Friend', avatar: null }
}
function threadOf(view: View): Thread | null {
  if (view.kind === 'group') return view.thread
  if (view.kind === 'direct') return { kind: 'direct', id: view.conversationId }
  return view.kind === 'room' && view.channelId ? { kind: 'channel', id: view.channelId } : null
}
export function ServerView({
  client,
  me,
  covered,
  voiceAvailable,
  onAccessChanged,
  onSettings,
  onServer,
}: {
  client: Transport
  me: Me
  covered: boolean
  voiceAvailable: boolean
  onAccessChanged: () => void
  onSettings: (serverName?: string) => void
  onServer?: () => void
}) {
  const [requestedView, setView] = useState<View>({ kind: 'home' })
  const [remembered, setRemembered] = useState<ReadonlyMap<RoomId, ChannelId>>(new Map())
  const [memberList, setMemberList] = useState(false)
  const [memberAttempt, setMemberAttempt] = useState(0)
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' })
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const voice = useVoiceCall(client)

  const sync = useServer(
    client,
    me.user.id,
    threadOf(requestedView),
    covered || dialog.kind !== 'none',
    onAccessChanged,
  )
  const showSettings = () =>
    onSettings(sync.state.kind === 'ready' ? sync.state.snapshot.server.name : undefined)
  const group =
    requestedView.kind === 'group'
      ? sync.groups.find((g) => threadKey(g.thread) === threadKey(requestedView.thread))
      : undefined
  const view: View = requestedView.kind === 'group' && !group ? { kind: 'home' } : requestedView
  const dialogGroup =
    dialog.kind === 'group-members' || dialog.kind === 'group-add'
      ? sync.groups.find((g) => threadKey(g.thread) === threadKey(dialog.thread))
      : undefined
  useEffect(() => {
    if (
      (dialog.kind === 'group-members' || dialog.kind === 'group-add') &&
      !dialogGroup &&
      sync.state.kind === 'ready'
    )
      setDialog({ kind: 'none' })
  }, [dialog.kind, dialogGroup, sync.state.kind])
  const members = useMembers(
    client,
    // A person in a call may have joined the server since the roster loaded.
    `${view.kind}:${dialog.kind}:${memberAttempt}:${sync.changes}:${me.user.name}:${JSON.stringify(me.user.avatar)}:${sync.presence.flatMap(({ people }) => people.map(({ id }) => id)).join()}`,
  )
  const snapshot = sync.state.kind === 'ready' ? sync.state.snapshot : null
  const rooms = snapshot?.rooms ?? []
  const channels = snapshot?.channels ?? []
  function open(next: View) {
    if (next.kind === 'room' && next.channelId) {
      const { roomId, channelId } = next
      setRemembered((current) => new Map(current).set(roomId, channelId))
    }
    setView(next)
  }
  function landing(roomId: RoomId) {
    const inRoom = channels.filter((channel) => channel.roomId === roomId)
    return (
      inRoom.find((channel) => channel.id === remembered.get(roomId)) ??
      inRoom.find((channel) => channel.kind === 'text') ??
      inRoom[0]
    )
  }
  function openRoom(roomId: RoomId) {
    open({ kind: 'room', roomId, channelId: landing(roomId)?.id ?? null })
  }
  if (view.kind === 'room' && !view.channelId && landing(view.roomId)) openRoom(view.roomId)
  const room = view.kind === 'room' ? rooms.find((room) => room.id === view.roomId) : undefined
  const channel =
    view.kind === 'room' ? channels.find((channel) => channel.id === view.channelId) : undefined
  if (!snapshot)
    return (
      <Frame>
        {onServer && <ServerCard server={{ origin: client.origin }} onServer={onServer} />}
        {sync.state.kind === 'failed' ? (
          <>
            <h1>We could not open this server.</h1>
            <p role="alert">{sync.state.message}</p>
            <button className="access-primary" onClick={sync.retry}>
              Try again
            </button>
            <button className="access-link" onClick={showSettings}>
              Settings
            </button>
          </>
        ) : (
          <h1 role="status">Opening your server…</h1>
        )}
      </Frame>
    )
  const server = snapshot.server
  const availability: VoiceAvailability = !voiceAvailable
    ? 'off'
    : document.documentElement.dataset.native
      ? 'desktop'
      : 'on'
  const roster = members.kind === 'ready' ? members.value : null
  const directs: DirectRow[] = sync.directs.map((direct) => ({
    ...direct,
    peer: peerOf(direct, roster, sync.messages),
  }))
  const direct =
    view.kind === 'direct' ? directs.find((item) => item.id === view.conversationId) : undefined
  const openDirect = (conversationId: ConversationId) => open({ kind: 'direct', conversationId })
  async function messageMember(userId: UserId, signal?: AbortSignal) {
    const conversation = await client.request(
      '/api/direct/conversations',
      DirectConversationSchema,
      {
        userId,
      },
      signal,
    )
    if (!client.active || signal?.aborted) return
    sync.include({ kind: 'direct.opened', conversation })
    setDialog({ kind: 'none' })
    openDirect(conversation.id)
  }
  return (
    <div className="app">
      <header className="titlebar">
        <Badge id={server.name} name={server.name} size={16} />
        <span>{server.name}</span>
      </header>
      <Sidebar
        client={client}
        me={me}
        server={server}
        rooms={rooms}
        channels={channels}
        unread={sync.unread}
        directs={directs}
        groups={sync.groups}
        view={view}
        connection={sync.connection}
        voice={voice}
        presence={sync.presence}
        members={roster}
        onView={open}
        onDirect={openDirect}
        onRoom={openRoom}
        onDialog={setDialog}
        onSettings={showSettings}
        onServer={onServer}
      />
      {view.kind === 'members' && server.role === 'admin' ? (
        <MembersPage
          client={client}
          me={me}
          server={server}
          members={members}
          onInvite={() => setDialog({ kind: 'invite' })}
          onMessage={messageMember}
          onRetry={() => setMemberAttempt((value) => value + 1)}
        />
      ) : channel?.kind === 'voice' ? (
        <VoiceChannel
          client={client}
          me={me}
          channel={channel}
          channels={channels}
          availability={availability}
          voice={voice}
          present={sync.presence.find(({ channelId }) => channelId === channel.id)?.people ?? []}
          roster={roster}
          memberList={memberList}
          onMemberList={() => setMemberList((value) => !value)}
        />
      ) : group ? (
        <GroupConversation
          key={threadKey(group.thread)}
          group={group}
          members={roster}
          client={client}
          me={me}
          sync={sync}
          onMembers={() => setDialog({ kind: 'group-members', thread: group.thread })}
          onSettings={showSettings}
          draft={sync.groupDraft(group.thread)}
          onDraft={(value) => sync.setGroupDraft(group.thread, value)}
        />
      ) : direct ? (
        <DirectConversation
          key={direct.id}
          client={client}
          me={me}
          direct={direct}
          onSettings={showSettings}
          sync={sync}
          draft={drafts[direct.id] ?? ''}
          onDraft={(value) => setDrafts((current) => ({ ...current, [direct.id]: value }))}
        />
      ) : channel ? (
        <ChannelConversation
          key={channel.id}
          client={client}
          me={me}
          channel={channel}
          memberCount={server.memberCount}
          onInvite={server.role === 'admin' ? () => setDialog({ kind: 'invite' }) : undefined}
          onSettings={showSettings}
          sync={sync}
          draft={drafts[channel.id] ?? ''}
          onDraft={(value) => setDrafts((current) => ({ ...current, [channel.id]: value }))}
          memberList={memberList}
          onMemberList={() => setMemberList((value) => !value)}
        />
      ) : room ? (
        <EmptyRoom
          room={room}
          memberCount={server.memberCount}
          admin={server.role === 'admin'}
          onDialog={setDialog}
          memberList={memberList}
          onMemberList={() => setMemberList((value) => !value)}
        />
      ) : (
        <Home
          client={client}
          me={me}
          server={server}
          rooms={rooms}
          channels={channels}
          members={roster}
          directs={directs}
          groups={sync.groups}
          onGroup={(thread) => open({ kind: 'group', thread })}
          unread={sync.unread}
          presence={sync.presence}
          onRoom={openRoom}
          onChannel={(channel) =>
            open({ kind: 'room', roomId: channel.roomId, channelId: channel.id })
          }
          onDirect={openDirect}
          onDialog={setDialog}
          memberList={memberList}
          onMemberList={() => setMemberList((value) => !value)}
        />
      )}
      {memberList && view.kind !== 'members' && !direct && !group && (
        <MemberList
          client={client}
          me={me}
          members={members}
          serverName={server.name}
          onSelect={(member, anchor) => setDialog({ kind: 'member', member, anchor })}
          onClose={() => setMemberList(false)}
          onRetry={() => setMemberAttempt((value) => value + 1)}
        />
      )}
      {dialog.kind === 'member' && (
        <MemberDetails
          key={dialog.member.id}
          client={client}
          member={roster?.find((member) => member.id === dialog.member.id) ?? dialog.member}
          serverName={server.name}
          anchor={dialog.anchor}
          onClose={() => setDialog({ kind: 'none' })}
          onMessage={messageMember}
        />
      )}
      {dialog.kind === 'room' && (
        <RoomDialog
          client={client}
          onClose={() => setDialog({ kind: 'none' })}
          onDone={(room) => {
            sync.include({ kind: 'room.created', room })
            setDialog({ kind: 'none' })
            open({ kind: 'room', roomId: room.id, channelId: null })
          }}
        />
      )}
      {dialog.kind === 'channel' && (
        <ChannelDialog
          client={client}
          room={rooms.find((room) => room.id === dialog.roomId) ?? { id: dialog.roomId, name: '' }}
          initialKind={dialog.channelKind}
          onClose={() => setDialog({ kind: 'none' })}
          onDone={(channel) => {
            sync.include({ kind: 'channel.created', channel })
            setDialog({ kind: 'none' })
            open({ kind: 'room', roomId: channel.roomId, channelId: channel.id })
          }}
        />
      )}
      {dialog.kind === 'direct' && (
        <NewMessageDialog
          serverName={server.name}
          client={client}
          me={me}
          members={members}
          onClose={() => setDialog({ kind: 'none' })}
          onChoose={messageMember}
          onGroup={() => setDialog({ kind: 'new-group' })}
          onInvite={server.role === 'admin' ? () => setDialog({ kind: 'invite' }) : null}
        />
      )}
      {(dialog.kind === 'new-group' || (dialog.kind === 'group-add' && dialogGroup)) && (
        <GroupPeopleDialog
          client={client}
          me={me}
          members={members}
          group={dialog.kind === 'group-add' ? dialogGroup : undefined}
          sync={sync}
          onClose={() => setDialog({ kind: 'none' })}
          onCreated={(thread) => {
            setDialog({ kind: 'none' })
            open({ kind: 'group', thread })
          }}
        />
      )}
      {dialog.kind === 'group-members' && dialogGroup && (
        <GroupMembersDialog
          group={dialogGroup}
          members={roster}
          client={client}
          me={me}
          onClose={() => setDialog({ kind: 'none' })}
          onAdd={() => setDialog({ kind: 'group-add', thread: dialogGroup.thread })}
          onLeave={async () => {
            await sync.leaveGroup(dialogGroup.thread)
            setDialog({ kind: 'none' })
          }}
        />
      )}
      {dialog.kind === 'invite' && (
        <InviteDialog
          client={client}
          serverName={server.name}
          onClose={() => setDialog({ kind: 'none' })}
        />
      )}
    </div>
  )
}
