import { createServer, type Socket } from 'node:net'
import { createServer as createTlsServer, createSecureContext, TLSSocket } from 'node:tls'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'

export type FixtureMode =
  | 'accept'
  | 'reject'
  | 'drop'
  | 'greeting-timeout'
  | 'deadline'
  | 'starttls'
  | 'tls'

export async function smtpFixture(mode: FixtureMode, certificate?: { cert: string; key: string }) {
  const credentials = certificate
    ? { cert: await readFile(certificate.cert), key: await readFile(certificate.key) }
    : undefined
  const sockets = new Set<Socket>()
  const messages: string[] = []
  const intervals = new Set<NodeJS.Timeout>()
  let connections = 0
  let closes = 0
  function handle(socket: Socket, greeting = true) {
    sockets.add(socket)
    if (greeting) connections++
    socket.on('error', () => {})
    socket.once('close', () => {
      sockets.delete(socket)
      if (greeting) closes++
    })
    if (mode === 'greeting-timeout') return
    if (greeting) socket.write('220 fixture ESMTP\r\n')
    let buffer = ''
    let data = false
    let payload = ''
    const received = (chunk: Buffer) => {
      buffer += chunk.toString()
      let end: number
      while ((end = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        if (data) {
          if (line !== '.') {
            payload += line + '\r\n'
            continue
          }
          data = false
          messages.push(payload)
          if (mode === 'drop') socket.destroy()
          else if (mode === 'deadline') {
            socket.write('250-still-processing\r\n')
            const interval = setInterval(() => socket.write('250-still-processing\r\n'), 500)
            intervals.add(interval)
            socket.once('close', () => {
              clearInterval(interval)
              intervals.delete(interval)
            })
          } else socket.write('250 accepted\r\n')
        } else if (/^EHLO|^HELO/.test(line)) {
          socket.write(
            mode === 'starttls' && !(socket instanceof TLSSocket)
              ? '250-fixture\r\n250 STARTTLS\r\n'
              : '250 fixture\r\n',
          )
        } else if (/^STARTTLS/.test(line)) {
          if (mode !== 'starttls' || !credentials) {
            socket.write('502 TLS unavailable\r\n')
            continue
          }
          socket.write('220 Begin TLS\r\n')
          socket.removeListener('data', received)
          const secure = new TLSSocket(socket, {
            isServer: true,
            secureContext: createSecureContext(credentials),
          })
          handle(secure, false)
          return
        } else if (/^MAIL FROM/.test(line)) socket.write('250 sender accepted\r\n')
        else if (/^RCPT TO/.test(line))
          socket.write(
            mode === 'reject'
              ? '550 rejected fixture-sensitive-password fixture-sensitive-code recipient@huddle.test\r\n'
              : '250 recipient accepted\r\n',
          )
        else if (line === 'DATA') {
          socket.write('354 send data\r\n')
          data = true
        } else if (line === 'QUIT') socket.end('221 goodbye\r\n')
        else socket.write('502 unsupported\r\n')
      }
    }
    socket.on('data', received)
  }
  const server =
    mode === 'tls'
      ? createTlsServer(credentials ?? {}, (socket) => handle(socket))
      : createServer((socket) => handle(socket))
  server.on('tlsClientError', () => {})
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture failed to listen')
  return {
    port: address.port,
    messages,
    get connections() {
      return connections
    },
    get closes() {
      return closes
    },
    async close() {
      for (const interval of intervals) clearInterval(interval)
      for (const socket of sockets) socket.destroy()
      server.close()
      await once(server, 'close')
    },
  }
}
