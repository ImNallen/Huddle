import { createServer } from 'vite'
import { startRealtime } from '../src/lib/realtime'
import { db } from '../src/lib/db'
const realtime = await startRealtime()
const vite = await createServer()
await vite.listen()
vite.printUrls()
async function stop() {
  realtime.clients.forEach((socket) => socket.terminate())
  realtime.close()
  await vite.close()
  await db.end()
  process.exit()
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
