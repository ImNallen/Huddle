import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import {
  GroupId,
  Admission,
  GroupMessage,
  GroupObservation,
  GroupRemoval,
  type CreateGroup,
  type GroupAccess,
  AccessStage,
  ChannelId,
  ConversationId,
  Cursor,
  DirectMessage,
  EventPage,
  Message,
  ServerEvent,
  Snapshot,
  UserId,
  type Channel,
  type DirectConversation,
  type Room,
  type RoomId,
  type VoicePresence,
} from '@huddle/contracts'
import { errorText, type Transport } from './transport'
import { RequestError } from './connection'
import {
  initialGroups,
  hasGroup,
  observeGroup,
  revokeGroup,
  snapshotGroups,
  groupMessage,
  groupThread,
  type GroupState,
  type GroupThread,
} from './groupState'

type SyncState =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; snapshot: Snapshot }
import {
  newerMessage,
  latestMessage,
  threadKey,
  type Thread,
  type ThreadMessage,
  type Pending,
  type Queued,
} from './chat'
export { threadKey, type Thread, type ThreadMessage, type Pending } from './chat'
const inChannel = ({ channelId, ...message }: Message): ThreadMessage => ({
  ...message,
  thread: { kind: 'channel', id: channelId },
})
const inDirect = ({ conversationId, ...message }: DirectMessage): ThreadMessage => ({
  ...message,
  thread: { kind: 'direct', id: conversationId },
})
type ThreadRoute = {
  message: z.ZodType<ThreadMessage>
  history: (id: string) => string
  send: { path: string; body: (id: string, retryId: string, body: string) => unknown }
  read: { path: string; body: (id: string, cursor: string) => unknown }
}
const threadRoutes: Record<'channel' | 'direct', ThreadRoute> = {
  channel: {
    message: Message.transform(inChannel),
    history: (id) => `/api/messages?channelId=${id}`,
    send: {
      path: '/api/messages',
      body: (channelId, retryId, body) => ({ channelId, retryId, body }),
    },
    read: { path: '/api/read', body: (channelId, cursor) => ({ channelId, cursor }) },
  },
  direct: {
    message: DirectMessage.transform(inDirect),
    history: (id) => `/api/direct/messages?conversationId=${id}`,
    send: {
      path: '/api/direct/messages',
      body: (conversationId, retryId, body) => ({ conversationId, retryId, body }),
    },
    read: {
      path: '/api/direct/read',
      body: (conversationId, cursor) => ({ conversationId, cursor }),
    },
  },
}
const StoredFields = {
  retryId: z.uuid(),
  body: z.string(),
  kind: z.enum(['sending', 'failed']),
  error: z.string().optional(),
}
const StoredPending = z.union([
  z.object({
    ...StoredFields,
    thread: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('channel'), id: ChannelId }),
      z.object({ kind: z.literal('direct'), id: ConversationId }),
      z.object({ kind: z.literal('group'), id: GroupId, admission: Admission }),
    ]),
    peerId: UserId.optional(),
  }),
  z.object({ ...StoredFields, channelId: ChannelId }).transform(({ channelId, ...item }) => ({
    ...item,
    thread: { kind: 'channel' as const, id: channelId },
  })),
])
function restorePending(storageKey: string): Pending[] {
  try {
    const rows = StoredPending.array().parse(
      JSON.parse(
        typeof localStorage === 'undefined' ? '[]' : (localStorage.getItem(storageKey) ?? '[]'),
      ),
    )
    return rows.map((item) => ({
      ...item,
      kind: 'failed',
      error: 'Sending was interrupted. Retry with the same message ID.',
    }))
  } catch {
    return []
  }
}
export type Activity = { count: number; mentions: number }
export type Unread = ReadonlyMap<string, Activity>
export type DirectThread = {
  id: ConversationId
  peerId: UserId
  latest: ThreadMessage | null
  unread: number
}
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)
const known: ReadonlySet<string> = new Set(
  ServerEvent.options.map((option) => option.shape.kind.value),
)
const UnknownEvent = z
  .object({ kind: z.string().refine((kind) => !known.has(kind)), cursor: Cursor })
  .transform(({ cursor }) => ({ kind: 'unknown' as const, cursor }))
const WatchedPage = EventPage.extend({ events: z.array(z.union([ServerEvent, UnknownEvent])) })
type Change =
  | { kind: 'room.created' | 'room.renamed'; room: Room }
  | { kind: 'room.deleted'; roomId: RoomId }
  | { kind: 'channel.created' | 'channel.renamed'; channel: Channel }
  | { kind: 'channel.deleted'; channelId: ChannelId }
  | { kind: 'server.renamed'; name: string }
  | { kind: 'direct.opened'; conversation: DirectConversation }
function apply(snapshot: Snapshot, change: Change): Snapshot {
  switch (change.kind) {
    case 'room.created':
    case 'room.renamed':
      return {
        ...snapshot,
        rooms: [...snapshot.rooms.filter((room) => room.id !== change.room.id), change.room].sort(
          byName,
        ),
      }
    case 'room.deleted':
      return {
        ...snapshot,
        rooms: snapshot.rooms.filter((room) => room.id !== change.roomId),
        channels: snapshot.channels.filter((channel) => channel.roomId !== change.roomId),
      }
    case 'channel.created':
    case 'channel.renamed':
      return {
        ...snapshot,
        channels: [
          ...snapshot.channels.filter((channel) => channel.id !== change.channel.id),
          change.channel,
        ].sort(byName),
      }
    case 'channel.deleted':
      return {
        ...snapshot,
        channels: snapshot.channels.filter((channel) => channel.id !== change.channelId),
      }
    case 'server.renamed':
      return { ...snapshot, server: { ...snapshot.server, name: change.name } }
    case 'direct.opened':
      return snapshot.directs.some((direct) => direct.id === change.conversation.id)
        ? snapshot
        : { ...snapshot, directs: [...snapshot.directs, change.conversation] }
  }
}
export type Departure = { rooms: Room[]; channels: Channel[] }
export function departed(before: Snapshot, after: Snapshot): Departure {
  const rooms = new Set(after.rooms.map((room) => room.id))
  const channels = new Set(after.channels.map((channel) => channel.id))
  return {
    rooms: before.rooms.filter((room) => !rooms.has(room.id)),
    channels: before.channels.filter((channel) => !channels.has(channel.id)),
  }
}
export const channelLabel = (channel: Channel) =>
  channel.kind === 'text' ? `#${channel.name}` : channel.name
function without<T>(map: ReadonlyMap<string, T>, keys: string[]): ReadonlyMap<string, T> {
  if (!keys.some((key) => map.has(key))) return map
  const next = new Map(map)
  for (const key of keys) next.delete(key)
  return next
}
function newestFirst(a: DirectThread, b: DirectThread) {
  if (!a.latest || !b.latest) return a.latest ? 1 : b.latest ? -1 : 0
  return BigInt(a.latest.cursor) > BigInt(b.latest.cursor) ? -1 : 1
}
function isVisible() {
  return typeof document === 'undefined' || document.visibilityState === 'visible'
}
export function useServer(
  client: Transport,
  userId: UserId,
  selected: Thread | null,
  covered: boolean,
  onAccessChanged: () => void,
) {
  const storageKey = `huddle.outbox:${client.origin}:${userId}`
  const [state, setState] = useState<SyncState>({ kind: 'loading' })
  const snapshotRef = useRef<Snapshot | null>(null)
  const [deleted, setDeleted] = useState<ReadonlyMap<string, string>>(new Map())
  const [drafts, setDrafts] = useState<ReadonlyMap<string, string>>(new Map())
  const channels = state.kind === 'ready' ? state.snapshot.channels : []
  const open =
    selected?.kind === 'direct' ||
    selected?.kind === 'group' ||
    (selected && channels.find((channel) => channel.id === selected.id)?.kind === 'text')
      ? selected
      : null
  const openKey = open && threadKey(open)
  const [messages, setMessages] = useState<ThreadMessage[]>([])
  const [unread, setUnread] = useState<Unread>(new Map())
  const [changes, setChanges] = useState(0)
  const [visible, setVisible] = useState(isVisible)
  const [pending, setPending] = useState<Pending[]>(() =>
    restorePending(storageKey).filter((p) => p.thread.kind !== 'group'),
  )
  const [groups, setGroups] = useState(() =>
    initialGroups(restorePending(storageKey).filter((p) => p.thread.kind === 'group')),
  )
  const groupsRef = useRef(groups)
  function updateGroups(update: (state: GroupState) => GroupState) {
    const next = update(groupsRef.current)
    groupsRef.current = next
    setGroups(next)
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify([
          ...pendingRef.current.filter((p) => p.thread.kind !== 'group'),
          ...next.pending,
        ]),
      )
    } catch {
      /* Revocation still clears memory when storage is full. */
    }
  }
  function groupFailure(thread: GroupThread, error: unknown) {
    if (error instanceof RequestError && error.status === 404)
      updateGroups((state) => revokeGroup(state, thread))
  }
  function allowed(thread: Thread) {
    return thread.kind !== 'group' || hasGroup(groupsRef.current, thread)
  }
  const pendingRef = useRef(pending.filter((p) => p.thread.kind !== 'group'))
  const [queueError, setQueueError] = useState('')
  function updatePending(update: (current: Pending[]) => Pending[]) {
    const next = update(pendingRef.current)
    try {
      localStorage.setItem(storageKey, JSON.stringify([...next, ...groupsRef.current.pending]))
    } catch {
      setQueueError('Could not save your outgoing message. Free local storage and try again.')
      return false
    }
    pendingRef.current = next
    setPending(next)
    setQueueError('')
    return true
  }
  const [connection, setConnection] = useState('Connecting')
  const [attempt, setAttempt] = useState(0)
  const [historyState, setHistoryState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [historyError, setHistoryError] = useState('')
  const currentClient = useRef(client)
  currentClient.current = client
  const active = useRef(true)
  const isActive = () => active.current && currentClient.current === client
  const cursor = useRef('0')
  const openRef = useRef(openKey)
  openRef.current = openKey
  const coveredRef = useRef(covered)
  coveredRef.current = covered
  const reads = useRef<Promise<unknown>>(Promise.resolve())
  const marked = useRef(new Map<string, string>())
  const historyBefore = useRef(new Map<string, string>())
  function rememberHistory(thread: Thread, rows: ThreadMessage[] | GroupMessage[]) {
    const first = rows[0]
    if (!first) return
    const key = threadKey(thread)
    const previous = historyBefore.current.get(key)
    if (!previous || BigInt(first.cursor) < BigInt(previous))
      historyBefore.current.set(key, first.cursor)
  }
  const flush = useRef<(() => void) | null>(null)
  const [presence, setPresence] = useState<VoicePresence>([])
  const presenceText = useRef('[]')
  /** Every socket frame carries the full list, and most repeat the last. */
  function showPresence(next: VoicePresence) {
    const text = JSON.stringify(next)
    if (text === presenceText.current) return
    presenceText.current = text
    setPresence(next)
  }
  useEffect(() => {
    active.current = true
    const update = () => setVisible(isVisible())
    document.addEventListener('visibilitychange', update)
    return () => {
      active.current = false
      document.removeEventListener('visibilitychange', update)
    }
  }, [])
  const threadStillExists = ({ thread }: ThreadMessage) =>
    thread.kind !== 'channel' ||
    !!snapshotRef.current?.channels.some((channel) => channel.id === thread.id)
  const merge = (incoming: ThreadMessage[]) => {
    const kept = incoming.filter(threadStillExists)
    setMessages((current) => {
      const indexed = new Map(current.map((message) => [message.id, message]))
      for (const message of kept)
        indexed.set(message.id, newerMessage(indexed.get(message.id), message))
      return [...indexed.values()].sort((a, b) => (BigInt(a.cursor) < BigInt(b.cursor) ? -1 : 1))
    })
  }
  function forgetChannels(ids: ReadonlySet<ChannelId>) {
    if (!ids.size) return
    const gone = (thread: Thread) => thread.kind === 'channel' && ids.has(thread.id)
    const keys = [...ids].map((id) => threadKey({ kind: 'channel', id }))
    setMessages((current) => current.filter((message) => !gone(message.thread)))
    if (pendingRef.current.some((item) => gone(item.thread)))
      updatePending((current) => current.filter((item) => !gone(item.thread)))
    setUnread((current) => without(current, keys))
    setDrafts((current) => without(current, keys))
    for (const key of keys) {
      marked.current.delete(key)
      historyBefore.current.delete(key)
    }
  }
  function commit(after: Snapshot, before: Snapshot | null, deletedWhileClosed: ChannelId[] = []) {
    snapshotRef.current = after
    setState({ kind: 'ready', snapshot: after })
    const gone = before ? departed(before, after) : { rooms: [], channels: [] }
    if (gone.rooms.length || gone.channels.length)
      setDeleted(
        (current) =>
          new Map([
            ...current,
            ...gone.rooms.map((room): [string, string] => [room.id, room.name]),
            ...gone.channels.map((channel): [string, string] => [
              channel.id,
              channelLabel(channel),
            ]),
          ]),
      )
    forgetChannels(new Set([...gone.channels.map((channel) => channel.id), ...deletedWhileClosed]))
  }
  const change = (update: Change) => {
    if (update.kind === 'direct.opened' && update.conversation.latest)
      merge([inDirect(update.conversation.latest)])
    if (snapshotRef.current) commit(apply(snapshotRef.current, update), snapshotRef.current)
  }
  const created = (
    update: { kind: 'room.created'; room: Room } | { kind: 'channel.created'; channel: Channel },
    at: string,
  ) => {
    if (BigInt(cursor.current) < BigInt(at)) change(update)
  }
  function read(thread: Thread, cursor: string) {
    if (thread.kind === 'group') {
      if (!allowed(thread)) return
      const access = { groupId: thread.id, admission: thread.admission }
      reads.current = reads.current
        .then(() => client.request('/api/group/read', z.unknown(), { ...access, cursor }))
        .catch((error) => {
          groupFailure(thread, error)
          marked.current.delete(threadKey(thread))
        })
      return
    }
    const route = threadRoutes[thread.kind].read
    reads.current = reads.current
      .then(() => client.request(route.path, z.unknown(), route.body(thread.id, cursor)))
      .catch(() => marked.current.delete(threadKey(thread)))
  }
  useEffect(() => {
    const abort = new AbortController()
    let socket: WebSocket | undefined
    let reconnect: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    cursor.current = '0'
    const previous = snapshotRef.current
    snapshotRef.current = null
    setState({ kind: 'loading' })
    setMessages([])
    historyBefore.current.clear()
    updateGroups((current) => ({ ...current, messages: [] }))
    setConnection('Connecting')
    async function start() {
      try {
        const [fresh, info] = await Promise.all([
          client.request('/api/snapshot', Snapshot, undefined, abort.signal),
          client.info(),
        ])
        if (stopped) return
        cursor.current = fresh.cursor
        updateGroups((current) => snapshotGroups(current, fresh.groups, fresh.cursor, userId))
        merge(fresh.directs.flatMap((direct) => (direct.latest ? [inDirect(direct.latest)] : [])))
        const channelIds = new Set(fresh.channels.map((channel) => channel.id))
        commit(
          pendingRef.current.reduce<Snapshot>(
            (current, { thread, peerId }) =>
              thread.kind === 'direct' && peerId
                ? apply(current, {
                    kind: 'direct.opened',
                    conversation: { id: thread.id, peerId, latest: null, unread: 0 },
                  })
                : current,
            { ...fresh, groups: [] },
          ),
          previous,
          pendingRef.current.flatMap(({ thread }) =>
            thread.kind === 'channel' && !channelIds.has(thread.id) ? [thread.id] : [],
          ),
        )
        setUnread(
          new Map([
            ...fresh.unread.map(({ channelId, count, mentions }): [string, Activity] => [
              threadKey({ kind: 'channel', id: channelId }),
              { count, mentions },
            ]),
            ...fresh.directs
              .filter((direct) => direct.unread)
              .map(({ id, unread: count }): [string, Activity] => [
                threadKey({ kind: 'direct', id }),
                { count, mentions: 0 },
              ]),
          ]),
        )
        async function watch() {
          if (stopped) return
          let stage: AccessStage
          try {
            stage = await client.request('/api/access', AccessStage)
          } catch {
            if (!stopped) {
              setConnection('Offline · reconnecting')
              reconnect = setTimeout(() => void watch(), 1800)
            }
            return
          }
          if (stopped) return
          if (stage.kind !== 'ready' || stage.user.id !== userId) {
            onAccessChanged()
            reconnect = setTimeout(() => void watch(), 1800)
            return
          }
          socket = new WebSocket(info.websocketUrl)
          socket.onopen = () =>
            socket?.send(JSON.stringify({ kind: 'watch', after: cursor.current }))
          socket.onmessage = (event) => {
            try {
              const page = WatchedPage.parse(JSON.parse(String(event.data)))
              let heard = false
              for (const event of page.events) {
                if (BigInt(event.cursor) <= BigInt(cursor.current)) continue
                switch (event.kind) {
                  case 'group.changed':
                    updateGroups((state) => observeGroup(state, event.group, event.cursor, userId))
                    heard = true
                    break
                  case 'group.removed':
                    updateGroups((state) =>
                      revokeGroup(
                        state,
                        { kind: 'group', id: event.groupId, admission: event.admission },
                        event.cursor,
                      ),
                    )
                    break
                  case 'group.message.created':
                  case 'group.message.edited': {
                    const thread = groupsRef.current.authority.get(event.message.groupId)?.current
                      ?.thread
                    if (thread)
                      updateGroups((state) =>
                        groupMessage(
                          state,
                          thread,
                          event.message,
                          true,
                          event.kind === 'group.message.created' &&
                            event.message.authorId !== userId &&
                            (threadKey(thread) !== openRef.current ||
                              coveredRef.current ||
                              !isVisible()),
                          event.cursor,
                        ),
                      )
                    if (event.kind === 'group.message.created') heard = true
                    break
                  }
                  case 'room.created':
                  case 'room.renamed':
                  case 'room.deleted':
                  case 'channel.created':
                  case 'channel.renamed':
                  case 'channel.deleted':
                  case 'server.renamed':
                    change(event)
                    break
                  case 'member.removed':
                    heard = true
                    break
                  case 'message.created':
                  case 'message.edited':
                  case 'direct.message.created':
                  case 'direct.message.edited': {
                    if (
                      event.kind === 'direct.message.created' ||
                      event.kind === 'direct.message.edited'
                    ) {
                      const [first, second] = event.participants
                      change({
                        kind: 'direct.opened',
                        conversation: {
                          id: event.message.conversationId,
                          peerId: first === userId ? second : first,
                          latest: event.message,
                          unread: 0,
                        },
                      })
                    }
                    const message =
                      event.kind === 'message.created' || event.kind === 'message.edited'
                        ? inChannel(event.message)
                        : inDirect(event.message)
                    const mentioned =
                      event.kind === 'message.created' && event.mentions.includes(userId)
                    merge([message])
                    if (event.kind === 'message.edited' || event.kind === 'direct.message.edited')
                      break
                    if (message.authorId === userId) {
                      updatePending((current) =>
                        current.filter((item) => item.retryId !== message.retryId),
                      )
                      break
                    }
                    heard = true
                    const key = threadKey(message.thread)
                    if (key !== openRef.current || coveredRef.current || !isVisible())
                      setUnread((current) => {
                        const { count, mentions } = current.get(key) ?? { count: 0, mentions: 0 }
                        return new Map(current).set(key, {
                          count: count + 1,
                          mentions: mentions + (mentioned ? 1 : 0),
                        })
                      })
                    break
                  }
                  case 'unknown':
                    break
                  default:
                    event satisfies never
                }
              }
              if (page.voice) showPresence(page.voice)
              const last = page.events.at(-1)
              if (last && BigInt(last.cursor) > BigInt(cursor.current)) cursor.current = last.cursor
              if (heard) setChanges((value) => value + 1)
              setConnection('Connected')
            } catch {
              socket?.close()
              setConnection('Could not read server events')
            }
          }
          socket.onclose = (event) => {
            if (stopped) return
            if (event.code === 4001) {
              void watch()
              return
            }
            setConnection('Offline · reconnecting')
            showPresence([])
            if (event.code === 1008) onAccessChanged()
            reconnect = setTimeout(() => void watch(), 1800)
          }
          socket.onerror = () => socket?.close()
        }
        void watch()
      } catch (error) {
        if (!stopped) setState({ kind: 'failed', message: errorText(error) })
      }
    }
    void start()
    return () => {
      stopped = true
      abort.abort()
      clearTimeout(reconnect)
      socket?.close()
    }
  }, [client, attempt])
  useEffect(() => {
    if (!open) {
      setHistoryState('ready')
      return
    }
    const abort = new AbortController()
    if (open.kind === 'group') {
      if (!allowed(open)) {
        setHistoryState('ready')
        return
      }
      setHistoryState('loading')
      setHistoryError('')
      void client
        .request(
          `/api/group/messages?groupId=${open.id}&admission=${open.admission}`,
          GroupMessage.array(),
          undefined,
          abort.signal,
        )
        .then((rows) => {
          if (abort.signal.aborted || !isActive() || !allowed(open)) return
          rememberHistory(open, rows)
          updateGroups((state) =>
            rows.reduce((next, message) => groupMessage(next, open, message), state),
          )
          setHistoryState('ready')
        })
        .catch((error) => {
          if (!abort.signal.aborted && isActive() && allowed(open)) {
            groupFailure(open, error)
            setHistoryState('failed')
            setHistoryError(errorText(error))
          }
        })
      return () => abort.abort()
    }
    const route = threadRoutes[open.kind]
    setHistoryState('loading')
    setHistoryError('')
    void client
      .request(route.history(open.id), route.message.array(), undefined, abort.signal)
      .then((messages) => {
        if (!abort.signal.aborted && isActive()) {
          rememberHistory(open, messages)
          merge(messages)
          const confirmed = new Set(
            messages
              .filter((message) => message.authorId === userId)
              .map((message) => message.retryId),
          )
          updatePending((current) => current.filter((item) => !confirmed.has(item.retryId)))
          setHistoryState('ready')
        }
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted) {
          setHistoryState('failed')
          setHistoryError(errorText(error))
        }
      })
    return () => abort.abort()
  }, [client, openKey, attempt])
  const allMessages = [...messages, ...groups.messages]
  const newest = new Map(allMessages.map((message) => [threadKey(message.thread), message]))
  const latest = openKey ? newest.get(openKey)?.cursor : undefined
  useEffect(() => {
    flush.current = null
    if (!open || !openKey || !visible || covered) return
    if (open.kind === 'group')
      updateGroups((state) => {
        const entry = state.authority.get(open.id)
        if (!entry?.current || !hasGroup(state, open)) return state
        return {
          ...state,
          authority: new Map(state.authority).set(open.id, {
            ...entry,
            current: { ...entry.current, group: { ...entry.current.group, unread: 0 } },
          }),
        }
      })
    setUnread((current) => {
      if (!current.has(openKey)) return current
      const next = new Map(current)
      next.delete(openKey)
      return next
    })
    if (!latest || marked.current.get(openKey) === latest) return
    const run = () => {
      clearTimeout(timer)
      flush.current = null
      marked.current.set(openKey, latest)
      read(open, latest)
    }
    const timer = setTimeout(run, 300)
    flush.current = run
    return () => clearTimeout(timer)
  }, [openKey, latest, visible, covered])
  useEffect(() => () => flush.current?.(), [openKey])
  const directs = (state.kind === 'ready' ? state.snapshot.directs : [])
    .map(({ id, peerId, latest: stored }): DirectThread => {
      const key = threadKey({ kind: 'direct', id })
      const live = newest.get(key)
      return {
        id,
        peerId,
        latest: latestMessage(stored && inDirect(stored), live ?? null),
        unread: unread.get(key)?.count ?? 0,
      }
    })
    .sort(newestFirst)
  async function send({ retryId, thread, peerId, body }: Queued) {
    if (thread.kind === 'group') {
      if (!allowed(thread)) return
      const item: Pending = { retryId, thread, body, kind: 'sending' }
      try {
        localStorage.setItem(
          storageKey,
          JSON.stringify([
            ...pendingRef.current,
            ...groupsRef.current.pending.filter((p) => p.retryId !== retryId),
            item,
          ]),
        )
      } catch {
        setQueueError('Could not save your outgoing message. Free local storage and try again.')
        return
      }
      updateGroups((state) => ({
        ...state,
        pending: [...state.pending.filter((p) => p.retryId !== retryId), item],
      }))
      try {
        const message = await client.request('/api/group/messages', GroupMessage, {
          groupId: thread.id,
          admission: thread.admission,
          retryId,
          body,
        })
        if (isActive()) updateGroups((state) => groupMessage(state, thread, message))
      } catch (error) {
        if (!isActive() || !allowed(thread)) return
        groupFailure(thread, error)
        updateGroups((state) =>
          !hasGroup(state, thread)
            ? state
            : {
                ...state,
                pending: state.pending.map((p) =>
                  p.retryId === retryId ? { ...p, kind: 'failed', error: errorText(error) } : p,
                ),
              },
        )
      }
      return
    }
    const item: Queued = {
      retryId,
      thread,
      body,
      peerId:
        thread.kind === 'direct'
          ? (peerId ?? directs.find((direct) => direct.id === thread.id)?.peerId)
          : undefined,
    }
    if (
      !updatePending((current) => [
        ...current.filter((pending) => pending.retryId !== item.retryId),
        { ...item, kind: 'sending' },
      ])
    )
      return
    try {
      const route = threadRoutes[thread.kind]
      const message = await client.request(
        route.send.path,
        route.message,
        route.send.body(thread.id, retryId, body),
      )
      if (!isActive()) return
      merge([message])
      updatePending((current) => current.filter((pending) => pending.retryId !== item.retryId))
    } catch (error) {
      if (isActive())
        updatePending((current) =>
          current.map((pending) =>
            pending.retryId === item.retryId
              ? { ...item, kind: 'failed', error: errorText(error) }
              : pending,
          ),
        )
    }
  }
  async function older() {
    const first = allMessages.find((message) => threadKey(message.thread) === openKey)
    if (!first || !open) return
    const before = historyBefore.current.get(threadKey(open)) ?? first.cursor
    if (open.kind === 'group') {
      if (!allowed(open)) return
      try {
        const rows = await client.request(
          `/api/group/messages?groupId=${open.id}&admission=${open.admission}&before=${before}`,
          GroupMessage.array(),
        )
        if (isActive() && allowed(open)) {
          rememberHistory(open, rows)
          updateGroups((state) =>
            rows.reduce((next, message) => groupMessage(next, open, message), state),
          )
        }
        return rows.length
      } catch (error) {
        if (isActive()) groupFailure(open, error)
        throw error
      }
    }
    const route = threadRoutes[open.kind]
    const rows = await client.request(
      `${route.history(open.id)}&before=${before}`,
      route.message.array(),
    )
    if (isActive()) {
      rememberHistory(open, rows)
      merge(rows)
    }
    return rows.length
  }
  return {
    state,
    messages: allMessages,
    pending: [
      ...pending.filter((p) => p.thread.kind !== 'group'),
      ...groups.pending.filter((p) => p.thread.kind === 'group' && hasGroup(groups, p.thread)),
    ],
    unread: new Map([
      ...unread,
      ...[...groups.authority.values()].flatMap((entry) =>
        entry.current && entry.current.group.unread
          ? [
              [
                threadKey(entry.current.thread),
                { count: entry.current.group.unread, mentions: 0 },
              ] as const,
            ]
          : [],
      ),
    ]),
    groups: [...groups.authority.values()]
      .flatMap((entry) =>
        entry.current ? [{ ...entry.current.group, thread: entry.current.thread }] : [],
      )
      .sort((a, b) =>
        BigInt(a.latest?.cursor ?? a.revision) > BigInt(b.latest?.cursor ?? b.revision) ? -1 : 1,
      ),
    draft: (thread: Thread) =>
      (thread.kind === 'group' ? groups.drafts : drafts).get(threadKey(thread)) ?? '',
    setDraft: (thread: Thread, body: string) => {
      if (thread.kind !== 'group')
        return setDrafts((current) => new Map(current).set(threadKey(thread), body))
      updateGroups((state) =>
        !hasGroup(state, thread)
          ? state
          : { ...state, drafts: new Map(state.drafts).set(threadKey(thread), body) },
      )
    },
    deleted,
    createGroup: async (input: z.infer<typeof CreateGroup>) => {
      const observation = await client.request('/api/groups', GroupObservation, input)
      if (!isActive()) return null
      updateGroups((state) =>
        observeGroup(state, observation.group, observation.at, userId, observation.group),
      )
      const thread = groupThread(observation.group, userId)
      return thread && hasGroup(groupsRef.current, thread) ? thread : null
    },
    addGroupPeople: async (thread: GroupThread, userIds: UserId[]) => {
      if (!allowed(thread)) return
      try {
        const result = await client.request('/api/group/people', GroupObservation, {
          groupId: thread.id,
          admission: thread.admission,
          userIds,
        })
        if (isActive() && allowed(thread))
          updateGroups((state) =>
            observeGroup(state, result.group, result.at, userId, result.group),
          )
      } catch (error) {
        if (isActive()) groupFailure(thread, error)
        throw error
      }
    },
    leaveGroup: async (thread: GroupThread) => {
      if (!allowed(thread)) return
      try {
        const result = await client.request('/api/group/leave', GroupRemoval, {
          groupId: thread.id,
          admission: thread.admission,
        } satisfies GroupAccess)
        if (isActive()) updateGroups((state) => revokeGroup(state, thread, result.cursor))
      } catch (error) {
        if (isActive()) groupFailure(thread, error)
        throw error
      }
    },
    directs,
    changes,
    presence,
    include: change,
    created,
    connection,
    historyState,
    historyError,
    queueError,
    edit: async (
      message: ThreadMessage,
      body: string,
      retryId: string,
      expectedRevision: string,
    ) => {
      const thread = message.thread
      if (!isActive() || !allowed(thread))
        throw new Error('This conversation is no longer available.')
      const fields = { messageId: message.id, expectedRevision, retryId, body }
      try {
        if (thread.kind === 'group') {
          const result = await client.request('/api/group/messages/edit', GroupMessage, {
            groupId: thread.id,
            admission: thread.admission,
            ...fields,
          })
          if (isActive() && allowed(thread))
            updateGroups((state) => groupMessage(state, thread, result))
        } else {
          const route =
            thread.kind === 'channel' ? '/api/messages/edit' : '/api/direct/messages/edit'
          const scope =
            thread.kind === 'channel' ? { channelId: thread.id } : { conversationId: thread.id }
          const result = await client.request(route, threadRoutes[thread.kind].message, {
            ...scope,
            ...fields,
          })
          if (isActive()) merge([result])
        }
      } catch (error) {
        if (isActive() && thread.kind === 'group') groupFailure(thread, error)
        throw error
      }
    },
    send,
    older,
    retry: () => setAttempt((value) => value + 1),
  }
}
