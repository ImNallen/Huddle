import { createServer } from 'vite'
import { startRealtime } from '../src/lib/realtime'
import { config } from '../src/lib/config'
import { db } from '../src/lib/db'
import { pruneAccess } from '../src/lib/access-maintenance'
import { prepareSetup } from '../src/lib/admission'
import { startDevServe } from './dev-serve'

const servePort = Number(new URL(config.SERVER_URL).port || 80)
if (servePort === config.PORT || servePort === config.WS_PORT)
  throw new Error(
    `pnpm dev plays tailscale serve on port ${servePort}, the port in SERVER_URL. Set PORT=3002, WS_PORT=3003, and WS_PUBLIC_URL=ws://localhost:${servePort}/events in .env.`,
  )
await prepareSetup()
const realtime = await startRealtime()
const vite = await createServer()
await vite.listen()
vite.printUrls()
const serve = startDevServe({
  port: servePort,
  http: config.PORT,
  ws: config.WS_PORT,
  login: process.env.HUDDLE_DEV_LOGIN ?? 'you@huddle.local',
})
process.stdout.write(
  `  Open ${config.SERVER_URL}. Development identity comes from runtime/dev-serve.ts.\n`,
)
const maintenance = setInterval(() => {
  void pruneAccess().catch(() => console.error({ event: 'access.maintenance.failed' }))
}, 60000)
maintenance.unref()
async function stop() {
  clearInterval(maintenance)
  serve.close()
  realtime.close()
  await vite.close()
  await db.end()
  process.exit()
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
