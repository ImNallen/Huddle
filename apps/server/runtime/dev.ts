import { createServer } from 'vite'
import { startRealtime } from '../src/lib/realtime'
import { db } from '../src/lib/db'
import { pruneAccess } from '../src/lib/access-maintenance'
import { prepareSetup } from '../src/lib/admission'
await prepareSetup()
const realtime = await startRealtime()
const vite = await createServer()
await vite.listen()
vite.printUrls()
const maintenance = setInterval(() => {
  void pruneAccess().catch(() => console.error({ event: 'access.maintenance.failed' }))
}, 60000)
maintenance.unref()
async function stop() {
  clearInterval(maintenance)
  realtime.clients.forEach((socket) => socket.terminate())
  realtime.close()
  await vite.close()
  await db.end()
  process.exit()
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
