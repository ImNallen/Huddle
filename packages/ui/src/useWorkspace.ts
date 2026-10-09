import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import {
  Channel,
  EventPage,
  Message,
  Snapshot,
  type Workspace,
  type UserId,
  SendMessage,
} from '@huddle/contracts'
import { errorText, type Transport } from './transport'

type WorkspaceState =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; snapshot: Snapshot }
const StoredPending = SendMessage.extend({
  kind: z.enum(['sending', 'failed']),
  error: z.string().optional(),
})
export type Pending =
  | { kind: 'sending'; retryId: string; channelId: Channel['id']; body: string }
  | { kind: 'failed'; retryId: string; channelId: Channel['id']; body: string; error: string }
export function useWorkspace(client: Transport, workspace: Workspace, userId: UserId) {
  const storageKey = `huddle.pending:${client.origin}:${userId}:${workspace.id}`
  const [state, setState] = useState<WorkspaceState>({ kind: 'loading' })
  const [messages, setMessages] = useState<Message[]>([])
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
  const [selected, setSelected] = useState<Channel['id'] | null>(null)
  const [historyState, setHistoryState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [historyError, setHistoryError] = useState('')
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const merge = (incoming: Message[]) =>
    setMessages((current) => {
      const indexed = new Map(current.map((message) => [message.id, message]))
      for (const message of incoming) indexed.set(message.id, message)
      return [...indexed.values()].sort((a, b) => (BigInt(a.cursor) < BigInt(b.cursor) ? -1 : 1))
    })
  useEffect(() => {
    const abort = new AbortController()
    let socket: WebSocket | undefined
    let reconnect: ReturnType<typeof setTimeout> | undefined
    let cursor = '0'
    let stopped = false
    setState({ kind: 'loading' })
    setMessages([])
    setConnection('Connecting')
    async function start() {
      try {
        const [snapshot, info] = await Promise.all([
          client.request(
            `/api/snapshot?workspaceId=${workspace.id}`,
            Snapshot,
            undefined,
            abort.signal,
          ),
          client.info(),
        ])
        if (stopped) return
        cursor = snapshot.cursor
        setState({ kind: 'ready', snapshot })
        setSelected((current) =>
          snapshot.channels.some((channel) => channel.id === current)
            ? current
            : (snapshot.channels[0]?.id ?? null),
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
            socket?.send(
              JSON.stringify({ kind: 'watch', workspaceId: workspace.id, after: cursor, ticket }),
            )
          socket.onmessage = (event) => {
            try {
              const page = EventPage.parse(JSON.parse(String(event.data)))
              for (const event of page.events) {
                if (BigInt(event.cursor) <= BigInt(cursor)) continue
                if (event.kind === 'message.created') {
                  merge([event.message])
                  if (event.message.authorId === userId)
                    updatePending((current) =>
                      current.filter((item) => item.retryId !== event.message.retryId),
                    )
                } else {
                  setState((current) =>
                    current.kind === 'ready'
                      ? {
                          kind: 'ready',
                          snapshot: {
                            ...current.snapshot,
                            channels: [
                              ...current.snapshot.channels.filter(
                                (channel) => channel.id !== event.channel.id,
                              ),
                              event.channel,
                            ].sort((a, b) => a.name.localeCompare(b.name)),
                          },
                        }
                      : current,
                  )
                  setSelected((current) => current ?? event.channel.id)
                }
              }
              const last = page.events.at(-1)
              if (last) cursor = last.cursor
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
  }, [client, workspace.id, attempt])
  useEffect(() => {
    if (!selected) {
      setHistoryState('ready')
      return
    }
    const abort = new AbortController()
    setHistoryState('loading')
    setHistoryError('')
    void client
      .request(`/api/messages?channelId=${selected}`, Message.array(), undefined, abort.signal)
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
  }, [client, selected, attempt])
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
    const first = messages.find((message) => message.channelId === selected)
    if (!first || !selected) return
    const rows = await client.request(
      `/api/messages?channelId=${selected}&before=${first.cursor}`,
      Message.array(),
    )
    merge(rows)
    return rows.length
  }
  return {
    state,
    messages,
    pending,
    selected,
    setSelected,
    connection,
    historyState,
    historyError,
    queueError,
    send,
    older,
    retry: () => setAttempt((value) => value + 1),
  }
}
