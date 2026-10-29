import { serve } from '@hono/node-server'
import { applicationRequest } from '../src/lib/http'
import { startRealtime } from '../src/lib/realtime'
import { openFriendPortal } from '../src/lib/portal'
import { config } from '../src/lib/config'
import { db } from '../src/lib/db'
import { prepareSetup } from '../src/lib/admission'

await prepareSetup()
const portal = await openFriendPortal()
const realtime = await startRealtime(portal.server)
await portal.listen()
const server = serve({
  fetch: (request, env) => applicationRequest(request, env.incoming.socket.remoteAddress),
  hostname: '127.0.0.1',
  port: config.PORT,
})
async function stop() {
  realtime.close()
  portal.close()
  server.close()
  await db.end()
  process.exit()
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
