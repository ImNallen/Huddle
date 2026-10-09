import { serve } from '@hono/node-server'
import { readFile } from 'node:fs/promises'
import { resolve, extname, sep } from 'node:path'
import { z } from 'zod'
import { startRealtime } from '../src/lib/realtime'
import { config } from '../src/lib/config'
import { db } from '../src/lib/db'

const serverPath = new URL('../dist/server/server.js', import.meta.url).href
const entry: unknown = await import(serverPath)
const handler = z
  .object({
    default: z.object({
      fetch: z.custom<(request: Request) => Promise<Response>>(
        (value) => typeof value === 'function',
      ),
    }),
  })
  .parse(entry).default
const clientRoot = resolve('dist/client')
const contentTypes: Record<string, string> = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}
const realtime = await startRealtime()
const server = serve({
  port: config.PORT,
  hostname: '0.0.0.0',
  fetch: async (request) => {
    const pathname = new URL(request.url).pathname
    if (pathname.startsWith('/assets/')) {
      const file = resolve(clientRoot, `.${decodeURIComponent(pathname)}`)
      if (!file.startsWith(clientRoot + sep)) return new Response(null, { status: 400 })
      try {
        return new Response(await readFile(file), {
          headers: {
            'Content-Type': contentTypes[extname(file)] ?? 'application/octet-stream',
            'Cache-Control': 'public, max-age=31536000, immutable',
          },
        })
      } catch {
        return new Response(null, { status: 404 })
      }
    }
    return handler.fetch(request)
  },
})
async function stop() {
  realtime.clients.forEach((socket) => socket.terminate())
  realtime.close()
  server.close()
  await db.end()
  process.exit()
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
