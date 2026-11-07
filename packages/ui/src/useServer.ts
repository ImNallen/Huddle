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
  DirectMessage,
  EventPage,
  Message,
  Snapshot,
  UserId,
  type Channel,
  type DirectConversation,
  type Room,
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
import { threadKey, type Thread, type ThreadMessage, type Pending, type Queued } from './chat'
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
type Change =
  | { kind: 'room.created'; room: Room }
  | { kind: 'channel.created'; channel: Channel }
  | { kind: 'direct.opened'; conversation: DirectConversation }
function apply(snapshot: Snapshot, change: Change): Snapshot {
  switch (change.kind) {
    case 'room.created':
      return {
        ...snapshot,
        rooms: [...snapshot.rooms.filter((room) => room.id !== change.room.id), change.room].sort(
          byName,
        ),
      }
    case 'channel.created':
      return {
        ...snapshot,
        channels: [
          ...snapshot.channels.filter((channel) => channel.id !== change.channel.id),
          change.channel,
        ].sort(byName),
      }
    case 'direct.opened':
      return snapshot.directs.some((direct) => direct.id === change.conversation.id)
        ? snapshot
        : { ...snapshot, directs: [...snapshot.directs, change.conversation] }
  }
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
  const active = useRef(true)
  const cursor = useRef('0')
  const openRef = useRef(openKey)
  openRef.current = openKey
  const coveredRef = useRef(covered)
  coveredRef.current = covered
  const reads = useRef<Promise<unknown>>(Promise.resolve())
  const marked = useRef(new Map<string, string>())
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
  const merge = (incoming: ThreadMessage[]) =>
    setMessages((current) => {
      const indexed = new Map(current.map((message) => [message.id, message]))
      for (const message of incoming) indexed.set(message.id, message)
      return [...indexed.values()].sort((a, b) => (BigInt(a.cursor) < BigInt(b.cursor) ? -1 : 1))
    })
  const change = (update: Change) =>
    setState((current) =>
      current.kind === 'ready'
        ? { kind: 'ready', snapshot: apply(current.snapshot, update) }
        : current,
    )
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
    setState({ kind: 'loading' })
    setMessages([])
    setConnection('Connecting')
    async function start() {
      try {
        const [snapshot, info] = await Promise.all([
          client.request('/api/snapshot', Snapshot, undefined, abort.signal),
          client.info(),
        ])
        if (stopped) return
        cursor.current = snapshot.cursor
        updateGroups((current) => snapshotGroups(current, snapshot.groups, snapshot.cursor, userId))
        setState({
          kind: 'ready',
          snapshot: pendingRef.current.reduce<Snapshot>(
            (current, { thread, peerId }) =>
              thread.kind === 'direct' && peerId
                ? apply(current, {
                    kind: 'direct.opened',
                    conversation: { id: thread.id, peerId, latest: null, unread: 0 },
                  })
                : current,
            { ...snapshot, groups: [] },
          ),
        })
        setUnread(
          new Map([
            ...snapshot.unread.map(({ channelId, count, mentions }): [string, Activity] => [
              threadKey({ kind: 'channel', id: channelId }),
              { count, mentions },
            ]),
            ...snapshot.directs
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
              const page = EventPage.parse(JSON.parse(String(event.data)))
              let heard = false
              for (const event of page.events) {
                if (BigInt(event.cursor) <= BigInt(cursor.current)) continue
                if (event.kind === 'group.changed') {
                  updateGroups((state) => observeGroup(state, event.group, event.cursor, userId))
                  heard = true
                  continue
                }
                if (event.kind === 'group.removed') {
                  updateGroups((state) =>
                    revokeGroup(
                      state,
                      { kind: 'group', id: event.groupId, admission: event.admission },
                      event.cursor,
                    ),
                  )
                  continue
                }
                if (event.kind === 'group.message.created') {
                  const thread = groupsRef.current.authority.get(event.message.groupId)?.current
                    ?.thread
                  if (thread)
                    updateGroups((state) =>
                      groupMessage(
                        state,
                        thread,
                        event.message,
                        true,
                        event.message.authorId !== userId &&
                          (threadKey(thread) !== openRef.current ||
                            coveredRef.current ||
                            !isVisible()),
                      ),
                    )
                  heard = true
                  continue
                }
                if (event.kind === 'room.created' || event.kind === 'channel.created') {
                  change(event)
                  continue
                }
                if (event.kind === 'direct.message.created') {
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
                  event.kind === 'message.created'
                    ? inChannel(event.message)
                    : inDirect(event.message)
                const mentioned =
                  event.kind === 'message.created' && event.mentions.includes(userId)
                merge([message])
                if (message.authorId === userId) {
                  updatePending((current) =>
                    current.filter((item) => item.retryId !== message.retryId),
                  )
                  continue
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
          if (abort.signal.aborted || !active.current || !allowed(open)) return
          updateGroups((state) =>
            rows.reduce((next, message) => groupMessage(next, open, message), state),
          )
          setHistoryState('ready')
        })
        .catch((error) => {
          if (!abort.signal.aborted && active.current && allowed(open)) {
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
        if (!abort.signal.aborted) {
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
        latest:
          live && (!stored || BigInt(live.cursor) >= BigInt(stored.cursor))
            ? live
            : stored && inDirect(stored),
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
        if (active.current) updateGroups((state) => groupMessage(state, thread, message))
      } catch (error) {
        if (!active.current || !allowed(thread)) return
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
      if (!active.current) return
      merge([message])
      updatePending((current) => current.filter((pending) => pending.retryId !== item.retryId))
    } catch (error) {
      if (active.current)
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
    if (open.kind === 'group') {
      if (!allowed(open)) return
      try {
        const rows = await client.request(
          `/api/group/messages?groupId=${open.id}&admission=${open.admission}&before=${first.cursor}`,
          GroupMessage.array(),
        )
        if (active.current && allowed(open))
          updateGroups((state) =>
            rows.reduce((next, message) => groupMessage(next, open, message), state),
          )
        return rows.length
      } catch (error) {
        if (active.current) groupFailure(open, error)
        throw error
      }
    }
    const route = threadRoutes[open.kind]
    const rows = await client.request(
      `${route.history(open.id)}&before=${first.cursor}`,
      route.message.array(),
    )
    merge(rows)
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
    groupDraft: (thread: GroupThread) => groups.drafts.get(threadKey(thread)) ?? '',
    setGroupDraft: (thread: GroupThread, body: string) =>
      updateGroups((state) =>
        !hasGroup(state, thread)
          ? state
          : { ...state, drafts: new Map(state.drafts).set(threadKey(thread), body) },
      ),
    createGroup: async (input: z.infer<typeof CreateGroup>) => {
      const observation = await client.request('/api/groups', GroupObservation, input)
      if (!active.current) return null
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
        if (active.current && allowed(thread))
          updateGroups((state) =>
            observeGroup(state, result.group, result.at, userId, result.group),
          )
      } catch (error) {
        if (active.current) groupFailure(thread, error)
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
        if (active.current) updateGroups((state) => revokeGroup(state, thread, result.cursor))
      } catch (error) {
        if (active.current) groupFailure(thread, error)
        throw error
      }
    },
    directs,
    changes,
    presence,
    include: change,
    connection,
    historyState,
    historyError,
    queueError,
    send,
    older,
    retry: () => setAttempt((value) => value + 1),
  }
}
