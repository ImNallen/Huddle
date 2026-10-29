import { createServer } from 'node:https'
import { type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { config } from './config'
import { applicationRequest } from './http'
import { lanAddresses, mapPort, setFriendReach } from './reach'
import { loadIdentity } from './server-cert'

export async function openFriendPortal() {
  const port = config.FRIEND_PORT
  const identity = await loadIdentity(`data/friend/${port}`)
  const server = createServer({ key: identity.key, cert: identity.certificate }, (req, res) => {
    if (req.headers.upgrade) return
    void handle(port, req, res).catch((error: unknown) => {
      console.error({
        event: 'friend.request.failed',
        error: error instanceof Error ? error.message : 'failed',
      })
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  return {
    server: server as Server,
    async listen() {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '0.0.0.0', () => {
          server.off('error', reject)
          resolve()
        })
      })
      const external = await mapPort(port)
      const lan = lanAddresses()
      if (process.env.HUDDLE_INVITE_LOOPBACK === '1') lan.unshift('127.0.0.1')
      await setFriendReach({ pin: identity.pin, port, lan: [...new Set(lan)], external })
      const remote = external ? ' Remote friends can use the invite.' : ' Remote friends cannot connect until this port is reachable.'
      const local = lan.length ? ' Friends on this network can use the invite in Huddle.' : ''
      process.stdout.write(`\nHuddle is listening for friends on port ${port}.${local}${remote}\n`)
    },
    close() {
      server.close()
    },
  }
}

async function handle(port: number, req: IncomingMessage, res: ServerResponse) {
  const host = req.headers.host ?? `127.0.0.1:${port}`
  const url = `https://${host}${req.url ?? '/'}`
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    const text = Array.isArray(value) ? value.join(', ') : value
    if (text) headers.set(key, text)
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  const request = new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
    duplex: 'half',
  } as RequestInit)
  const response = await applicationRequest(request, req.socket.remoteAddress)
  const out: Record<string, string | string[]> = {}
  response.headers.forEach((value, key) => {
    const current = out[key]
    if (current === undefined) out[key] = value
    else if (Array.isArray(current)) current.push(value)
    else out[key] = [current, value]
  })
  res.writeHead(response.status, out)
  if (!response.body) {
    res.end()
    return
  }
  const reader = response.body.getReader()
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    if (!res.write(next.value)) await new Promise((resolve) => res.once('drain', resolve))
  }
  res.end()
}
