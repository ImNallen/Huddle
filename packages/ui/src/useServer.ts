import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import {
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
} from '@huddle/contracts'
import { errorText, type Transport } from './transport'

type SyncState =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; snapshot: Snapshot }
export type Thread = { kind: 'channel'; id: ChannelId } | { kind: 'direct'; id: ConversationId }
export const threadKey = (thread: Thread) => `${thread.kind}:${thread.id}`
export type ThreadMessage = Omit<Message, 'channelId'> & { thread: Thread }
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
const threadRoutes: Record<Thread['kind'], ThreadRoute> = {
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
    ]),
    peerId: UserId.optional(),
  }),
  z.object({ ...StoredFields, channelId: ChannelId }).transform(({ channelId, ...item }) => ({
    ...item,
    thread: { kind: 'channel' as const, id: channelId },
  })),
])
type Queued = { retryId: string; thread: Thread; peerId?: UserId; body: string }
export type Pending = Queued & ({ kind: 'sending' } | { kind: 'failed'; error: string })
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
) {
  const storageKey = `huddle.outbox:${client.origin}:${userId}`
  const [state, setState] = useState<SyncState>({ kind: 'loading' })
  const channels = state.kind === 'ready' ? state.snapshot.channels : []
  const open =
    selected?.kind === 'direct' ||
    (selected && channels.find((channel) => channel.id === selected.id)?.kind === 'text')
      ? selected
      : null
  const openKey = open && threadKey(open)
  const [messages, setMessages] = useState<ThreadMessage[]>([])
  const [unread, setUnread] = useState<Unread>(new Map())
  const [changes, setChanges] = useState(0)
  const [visible, setVisible] = useState(isVisible)
  const [pending, setPending] = useState<Pending[]>(() => {
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
  })
  const pendingRef = useRef(pending)
  const [queueError, setQueueError] = useState('')
  function updatePending(update: (current: Pending[]) => Pending[]) {
    const next = update(pendingRef.current)
    try {
      localStorage.setItem(storageKey, JSON.stringify(next))
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
        setState({
          kind: 'ready',
          snapshot: pendingRef.current.reduce(
            (current, { thread, peerId }) =>
              thread.kind === 'direct' && peerId
                ? apply(current, {
                    kind: 'direct.opened',
                    conversation: { id: thread.id, peerId, latest: null, unread: 0 },
                  })
                : current,
            snapshot,
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
          let ticket: string
          try {
            ;({ ticket } = await client.request(
              '/api/watch-ticket',
              z.object({ ticket: z.string() }),
              {},
            ))
          } catch {
            if (!stopped) {
              setConnection('Offline · reconnecting')
              reconnect = setTimeout(() => void watch(), 1800)
            }
            return
          }
          if (stopped) return
          socket = new WebSocket(info.websocketUrl)
          socket.onopen = () =>
            socket?.send(JSON.stringify({ kind: 'watch', after: cursor.current, ticket }))
          socket.onmessage = (event) => {
            try {
              const page = EventPage.parse(JSON.parse(String(event.data)))
              let heard = false
              for (const event of page.events) {
                if (BigInt(event.cursor) <= BigInt(cursor.current)) continue
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
            setConnection(
              event.code === 1008
                ? 'Session or access expired. Sign in again.'
                : 'Offline · reconnecting',
            )
            if (event.code !== 1008) reconnect = setTimeout(() => void watch(), 1800)
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
  const newest = new Map(messages.map((message) => [threadKey(message.thread), message]))
  const latest = openKey ? newest.get(openKey)?.cursor : undefined
  useEffect(() => {
    flush.current = null
    if (!open || !openKey || !visible || covered) return
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
    const first = messages.find((message) => threadKey(message.thread) === openKey)
    if (!first || !open) return
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
    messages,
    pending,
    unread,
    directs,
    changes,
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
