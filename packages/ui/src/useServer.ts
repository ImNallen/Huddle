import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import {
  EventPage,
  Message,
  Snapshot,
  type ChannelId,
  type Channel,
  type Room,
  type UserId,
  SendMessage,
} from '@huddle/contracts'
import { errorText, type Transport } from './transport'

type SyncState =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; snapshot: Snapshot }
const StoredPending = SendMessage.extend({
  kind: z.enum(['sending', 'failed']),
  error: z.string().optional(),
})
export type Pending =
  | { kind: 'sending'; retryId: string; channelId: ChannelId; body: string }
  | { kind: 'failed'; retryId: string; channelId: ChannelId; body: string; error: string }
export type Unread = ReadonlyMap<ChannelId, number>
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)
type Created = { kind: 'room.created'; room: Room } | { kind: 'channel.created'; channel: Channel }
function apply(snapshot: Snapshot, event: Created) {
  switch (event.kind) {
    case 'room.created':
      return {
        ...snapshot,
        rooms: [...snapshot.rooms.filter((room) => room.id !== event.room.id), event.room].sort(
          byName,
        ),
      }
    case 'channel.created':
      return {
        ...snapshot,
        channels: [
          ...snapshot.channels.filter((channel) => channel.id !== event.channel.id),
          event.channel,
        ].sort(byName),
      }
  }
}
function isVisible() {
  return typeof document === 'undefined' || document.visibilityState === 'visible'
}
export function useServer(client: Transport, userId: UserId, open: ChannelId | null) {
  const storageKey = `huddle.outbox:${client.origin}:${userId}`
  const [state, setState] = useState<SyncState>({ kind: 'loading' })
  const [messages, setMessages] = useState<Message[]>([])
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
  const openRef = useRef(open)
  openRef.current = open
  const reads = useRef<Promise<unknown>>(Promise.resolve())
  const marked = useRef(new Map<ChannelId, string>())
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
  const merge = (incoming: Message[]) =>
    setMessages((current) => {
      const indexed = new Map(current.map((message) => [message.id, message]))
      for (const message of incoming) indexed.set(message.id, message)
      return [...indexed.values()].sort((a, b) => (BigInt(a.cursor) < BigInt(b.cursor) ? -1 : 1))
    })
  function read(body: { kind: 'channel'; channelId: ChannelId; cursor: string }) {
    reads.current = reads.current
      .then(() => client.request('/api/read', z.unknown(), body))
      .then(
        () => setChanges((value) => value + 1),
        () => marked.current.delete(body.channelId),
      )
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
        setState({ kind: 'ready', snapshot })
        setUnread(new Map(snapshot.unread.map((item) => [item.channelId, item.count])))
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
                if (event.kind !== 'message.created') {
                  setState((current) =>
                    current.kind === 'ready'
                      ? { kind: 'ready', snapshot: apply(current.snapshot, event) }
                      : current,
                  )
                  continue
                }
                const message = event.message
                merge([message])
                if (message.authorId === userId) {
                  updatePending((current) =>
                    current.filter((item) => item.retryId !== message.retryId),
                  )
                  continue
                }
                heard = true
                if (message.channelId !== openRef.current || !isVisible())
                  setUnread((current) =>
                    new Map(current).set(
                      message.channelId,
                      (current.get(message.channelId) ?? 0) + 1,
                    ),
                  )
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
    setHistoryState('loading')
    setHistoryError('')
    void client
      .request(`/api/messages?channelId=${open}`, Message.array(), undefined, abort.signal)
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
  }, [client, open, attempt])
  const latest = open
    ? messages.filter((message) => message.channelId === open).at(-1)?.cursor
    : undefined
  useEffect(() => {
    flush.current = null
    if (!open || !visible) return
    setUnread((current) => {
      if (!current.has(open)) return current
      const next = new Map(current)
      next.delete(open)
      return next
    })
    if (!latest || marked.current.get(open) === latest) return
    const run = () => {
      clearTimeout(timer)
      flush.current = null
      marked.current.set(open, latest)
      read({ kind: 'channel', channelId: open, cursor: latest })
    }
    const timer = setTimeout(run, 300)
    flush.current = run
    return () => clearTimeout(timer)
  }, [open, latest, visible])
  useEffect(() => () => flush.current?.(), [open])
  async function send(item: Pick<Pending, 'retryId' | 'body' | 'channelId'>) {
    if (
      !updatePending((current) => [
        ...current.filter((pending) => pending.retryId !== item.retryId),
        { ...item, kind: 'sending' },
      ])
    )
      return
    try {
      const message = await client.request('/api/messages', Message, {
        channelId: item.channelId,
        retryId: item.retryId,
        body: item.body,
      })
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
    const first = messages.find((message) => message.channelId === open)
    if (!first || !open) return
    const rows = await client.request(
      `/api/messages?channelId=${open}&before=${first.cursor}`,
      Message.array(),
    )
    merge(rows)
    return rows.length
  }
  async function markAllRead() {
    const request = reads.current.then(() =>
      client.request('/api/read', z.unknown(), { kind: 'all', cursor: cursor.current }),
    )
    reads.current = request.catch(() => undefined)
    await request
    if (!active.current) return
    setUnread(new Map())
    setChanges((value) => value + 1)
  }
  return {
    state,
    messages,
    pending,
    unread,
    changes,
    include: (created: Created) =>
      setState((current) =>
        current.kind === 'ready'
          ? { kind: 'ready', snapshot: apply(current.snapshot, created) }
          : current,
      ),
    connection,
    historyState,
    historyError,
    queueError,
    send,
    older,
    markAllRead,
    settled: () => reads.current,
    retry: () => setAttempt((value) => value + 1),
  }
}
