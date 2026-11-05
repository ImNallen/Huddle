import { WebSocket, WebSocketServer } from 'ws'
import { WatchFrame, type UserId } from '@huddle/contracts'
import { config } from './config'
import { replay } from './domain'
import { db } from './db'
import { contextAllowed, requireAccess, upgradeHeaders } from './identity'

export async function startRealtime() {
  const wakeups = new Set<() => void>()
  const listener = await db.connect()
  await listener.query('LISTEN huddle_commit')
  listener.on('notification', () => {
    for (const wake of wakeups) wake()
  })
  listener.on('error', (error) => console.error({ event: 'realtime.wakeup.failed', error }))
  const server = new WebSocketServer({
    port: config.WS_PORT,
    host: '127.0.0.1',
    maxPayload: 8192,
    perMessageDeflate: false,
    verifyClient: ({ req }, done) =>
      done(
        contextAllowed(upgradeHeaders(req.headers), 'write') &&
          req.url === '/' &&
          server.clients.size < 500,
        403,
        'Forbidden',
      ),
  })
  let released = false
  const release = () => {
    if (released) return
    released = true
    listener.release()
  }
  server.once('close', release)
  server.on('connection', (socket, request) => {
    const headers = upgradeHeaders(request.headers)
    let watch: { after: string } | undefined
    let watcher: UserId | undefined
    let frameReceived = false
    let busy = false
    let closed = false
    const deadline = setTimeout(
      () => socket.close(1008, 'Send a watch frame within five seconds.'),
      5000,
    )
    // Serve attests a socket once, at upgrade, and nothing here can see a Tailscale ACL change. Closing
    // on a timer makes the client reconnect, so Serve attests it again.
    const aged = setTimeout(
      () => socket.close(4001, 'Reconnect to re-check access.'),
      config.SOCKET_MAX_AGE_SECONDS * (1 + Math.random() * 0.1) * 1000,
    )
    async function pump(sendEmpty = true) {
      if (!watch || busy || closed) return
      busy = true
      try {
        const { user } = await requireAccess(headers)
        watcher ??= user.id
        if (user.id !== watcher) {
          socket.close(1008, 'This login now belongs to another account.')
          return
        }
        const { events, scanned } = await replay(user.id, watch.after)
        if (socket.bufferedAmount > 512 * 1024) {
          socket.close(1013, 'Reconnect to catch up.')
          return
        }
        if (socket.readyState === WebSocket.OPEN) {
          if (sendEmpty || events.length) socket.send(JSON.stringify({ kind: 'events', events }))
          watch.after = scanned
        }
      } catch {
        socket.close(1008, 'Access ended or the server is unavailable.')
      } finally {
        busy = false
      }
    }
    socket.on('message', (data, isBinary) => {
      if (frameReceived || isBinary) {
        socket.close(1008, 'Only one watch frame is allowed.')
        return
      }
      frameReceived = true
      try {
        const frame = WatchFrame.parse(JSON.parse(data.toString()))
        watch = { after: frame.after }
        clearTimeout(deadline)
        void pump()
      } catch {
        socket.close(1008, 'Invalid watch frame.')
      }
    })
    const interval = setInterval(() => void pump(), 1000)
    const onCommit = () => void pump(false)
    wakeups.add(onCommit)
    socket.on('error', () => socket.close())
    socket.on('close', () => {
      closed = true
      clearTimeout(deadline)
      clearTimeout(aged)
      clearInterval(interval)
      wakeups.delete(onCommit)
    })
  })
  return {
    close() {
      for (const socket of server.clients) socket.terminate()
      server.close()
      release()
    },
  }
}
