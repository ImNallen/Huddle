import {
  createServer,
  request as forward,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from 'node:http'
import { connect } from 'node:net'
import type { Duplex } from 'node:stream'
import { config } from '../src/lib/config'

const clientIdentity = [
  'tailscale-user-login',
  'tailscale-user-name',
  'tailscale-user-profile-pic',
  'tailscale-headers-info',
  'tailscale-funnel-request',
]
function cookieLogin(cookie: string | undefined) {
  return /(?:^|;\s*)huddle-dev-login=([\w.+-]+@[\w.-]+)/.exec(cookie ?? '')?.[1]
}
function attested(request: IncomingMessage, login: string): IncomingHttpHeaders {
  const headers = { ...request.headers }
  for (const name of clientIdentity) delete headers[name]
  const person = cookieLogin(request.headers.cookie) ?? login
  return {
    ...headers,
    'tailscale-user-login': person,
    'tailscale-user-name': person.slice(0, person.indexOf('@')),
    'x-forwarded-host': request.headers.host ?? '',
    'x-forwarded-proto': 'http',
    'x-forwarded-for': '127.0.0.1',
  }
}

export function startDevServe(options: { port: number; http: number; ws: number; login: string }) {
  const { protocol, hostname } = new URL(config.SERVER_URL)
  if (protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(hostname))
    throw new Error('dev-serve plays tailscale serve only for a loopback HTTP SERVER_URL.')
  const server = createServer((request, response) => {
    const upstream = forward(
      {
        host: '127.0.0.1',
        port: options.http,
        method: request.method,
        path: request.url,
        headers: attested(request, options.login),
      },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers)
        answer.pipe(response)
      },
    )
    upstream.on('error', () => response.destroy())
    request.pipe(upstream)
  })
  server.on('upgrade', (request, client: Duplex, head) => {
    const events = request.url === '/events'
    const upstream = connect(events ? options.ws : options.http, '127.0.0.1', () => {
      const lines = Object.entries(attested(request, options.login)).flatMap(([name, value]) =>
        (Array.isArray(value) ? value : [value ?? '']).map((item) => `${name}: ${item}`),
      )
      upstream.write(`GET ${events ? '/' : request.url} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`)
      upstream.write(head)
      client.pipe(upstream).pipe(client)
    })
    upstream.on('error', () => client.destroy())
    client.on('error', () => upstream.destroy())
  })
  server.listen(options.port, '127.0.0.1')
  return {
    close() {
      server.closeAllConnections()
      server.close()
    },
  }
}
