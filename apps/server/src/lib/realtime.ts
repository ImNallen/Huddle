import type { Server } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { UserId, WatchFrame } from '@huddle/contracts'
import { requireAccess } from './access'
import { config, origins } from './config'
import { replay, consumeWatchTicket } from './domain'
import { db } from './db'

export async function startRealtime(friend?: Server) {
  const wakeups = new Set<() => void>()
  const listener = await db.connect()
  await listener.query('LISTEN huddle_commit')
  listener.on('notification', () => {
    for (const wake of wakeups) wake()
  })
  listener.on('error', (error) => console.error({ event: 'realtime.wakeup.failed', error }))
  const plain = new WebSocketServer({
    port: config.WS_PORT,
    host: '127.0.0.1',
    maxPayload: 8192,
    perMessageDeflate: false,
    verifyClient: ({ origin, req }, done) =>
      done(
        Boolean(origin && origins.has(origin) && req.url === '/' && plain.clients.size < 500),
        403,
        'Forbidden',
      ),
  })
  const secureBox: { current?: WebSocketServer } = {}
  const secure = friend
    ? new WebSocketServer({
        server: friend,
        maxPayload: 8192,
        perMessageDeflate: false,
        verifyClient: ({ origin, req }, done) =>
          done(
            Boolean(
              origin &&
                origins.has(origin) &&
                req.url === '/' &&
                (secureBox.current?.clients.size ?? 0) < 500,
            ),
            403,
            'Forbidden',
          ),
      })
    : undefined
  secureBox.current = secure
  let released = false
  const release = () => {
    if (released) return
    released = true
    listener.release()
  }
  plain.once('close', release)
  secure?.once('close', release)
  const servers = secure ? [plain, secure] : [plain]
  for (const socketServer of servers)
    socketServer.on('connection', (socket, request) => {
    const headers = new Headers()
    if (request.headers.cookie) headers.set('cookie', request.headers.cookie)
    let watch: { after: string } | undefined
    let frameReceived = false
    let busy = false
    let closed = false
    const deadline = setTimeout(() => socket.close(1008, 'Authenticate within five seconds.'), 5000)
    async function pump() {
      if (!watch || busy || closed) return
      busy = true
      try {
        const session = await requireAccess(headers)
        if (!session) {
          socket.close(1008, 'Session expired.')
          return
        }
        const events = await replay(UserId.parse(session.user.id), watch.after)
        if (socket.bufferedAmount > 512 * 1024) {
          socket.close(1013, 'Reconnect to catch up.')
          return
        }
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ kind: 'events', events }))
          const last = events.at(-1)
          if (last) watch.after = last.cursor
        }
      } catch {
        socket.close(1008, 'Server or session unavailable.')
      } finally {
        busy = false
      }
    }
    socket.on('message', async (data, isBinary) => {
      if (frameReceived || isBinary) {
        socket.close(1008, 'Only one watch frame is allowed.')
        return
      }
      frameReceived = true
      try {
        const frame = WatchFrame.parse(JSON.parse(data.toString()))
        if (frame.ticket)
          headers.set('authorization', `Bearer ${await consumeWatchTicket(frame.ticket)}`)
        if (frame.token) headers.set('authorization', `Bearer ${frame.token}`)
        watch = { after: frame.after }
        clearTimeout(deadline)
        void pump()
      } catch {
        socket.close(1008, 'Invalid watch frame.')
      }
    })
    const interval = setInterval(() => void pump(), 1000)
    const onCommit = () => void pump()
    wakeups.add(onCommit)
    socket.on('error', () => socket.close())
    socket.on('close', () => {
      closed = true
      clearTimeout(deadline)
      clearInterval(interval)
      wakeups.delete(onCommit)
    })
  })
  return {
    close() {
      for (const socketServer of servers) {
        for (const socket of socketServer.clients) socket.terminate()
        socketServer.close()
      }
      release()
    },
  }
}
