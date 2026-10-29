import { createServer } from 'vite'
import { startRealtime } from '../src/lib/realtime'
import { openFriendPortal } from '../src/lib/portal'
import { db } from '../src/lib/db'
import { pruneAccess } from '../src/lib/access-maintenance'
import { prepareSetup } from '../src/lib/admission'
await prepareSetup()
const portal = await openFriendPortal()
const realtime = await startRealtime(portal.server)
await portal.listen()
const vite = await createServer()
await vite.listen()
vite.printUrls()
const maintenance = setInterval(() => {
  void pruneAccess().catch(() => console.error({ event: 'access.maintenance.failed' }))
}, 60000)
maintenance.unref()
async function stop() {
  clearInterval(maintenance)
  realtime.close()
  portal.close()
  await vite.close()
  await db.end()
  process.exit()
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
