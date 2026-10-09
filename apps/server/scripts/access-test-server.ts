import { serve } from '@hono/node-server'
import { applicationRequest } from '../src/lib/http'
import { startRealtime } from '../src/lib/realtime'
import { config } from '../src/lib/config'
import { db } from '../src/lib/db'
import { pruneAccess } from '../src/lib/access-maintenance'

const realtime = await startRealtime()
const server = serve({
  fetch: (request, env) => applicationRequest(request, env.incoming.socket.remoteAddress),
  hostname: '127.0.0.1',
  port: config.PORT,
})
process.stdout.write(`Access test server listening on ${config.PORT}.\n`)
const maintenance = setInterval(() => {
  void pruneAccess().catch(() => console.error({ event: 'access.maintenance.failed' }))
}, 60000)
maintenance.unref()
async function stop() {
  clearInterval(maintenance)
  realtime.clients.forEach((socket) => socket.terminate())
  realtime.close()
  server.close()
  await db.end()
  process.exit()
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
