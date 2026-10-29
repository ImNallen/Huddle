import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:https'
import tls from 'node:tls'
import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { AccessView, Channel, FriendInvites, Message, Room, parseInvite } from '@huddle/contracts'
import { migratedDatabase, startServer } from './harness'
import { loadIdentity, pinCertificate } from '../src/lib/server-cert'

const serverRoot = fileURLToPath(new URL('..', import.meta.url))

function wrongPin(pin: string) {
  return `${pin[0] === 'A' ? 'B' : 'A'}${pin.slice(1)}`
}

function decodeBody(body: Buffer) {
  const text = body.toString('utf8')
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function chunkSize(line: string) {
  const hex = line.split(';')[0]?.trim() ?? ''
  if (!/^[0-9a-fA-F]+$/.test(hex)) return undefined
  return Number.parseInt(hex, 16)
}

function readChunks(buffer: Buffer) {
  const parts: Buffer[] = []
  let offset = 0
  while (offset < buffer.length) {
    const lineEnd = buffer.indexOf('\r\n', offset)
    if (lineEnd < 0) return undefined
    const size = chunkSize(buffer.subarray(offset, lineEnd).toString('latin1'))
    if (size === undefined) return undefined
    const start = lineEnd + 2
    if (size === 0) {
      if (buffer.indexOf('\r\n\r\n', lineEnd) < 0) return undefined
      return Buffer.concat(parts)
    }
    if (buffer.length < start + size + 2) return undefined
    parts.push(buffer.subarray(start, start + size))
    offset = start + size + 2
  }
  return undefined
}

function readHttp(buffer: Buffer, closed: boolean) {
  const headerEnd = buffer.indexOf('\r\n\r\n')
  if (headerEnd < 0) return undefined
  const lines = buffer.subarray(0, headerEnd).toString('latin1').split('\r\n')
  const status = Number(lines[0]?.split(' ')[1] ?? 0)
  const headers = new Map<string, string>()
  for (const line of lines.slice(1)) {
    const cut = line.indexOf(':')
    if (cut < 0) continue
    headers.set(line.slice(0, cut).trim().toLowerCase(), line.slice(cut + 1).trim())
  }
  const rest = buffer.subarray(headerEnd + 4)
  let body: Buffer | undefined
  if (headers.get('transfer-encoding')?.toLowerCase().includes('chunked')) {
    body = readChunks(rest)
  } else if (headers.has('content-length')) {
    const length = Number(headers.get('content-length'))
    if (!Number.isInteger(length) || length < 0 || rest.length < length) return undefined
    body = rest.subarray(0, length)
  } else if (closed) {
    body = rest
  }
  if (!body) return undefined
  return { status, json: decodeBody(body) }
}

function pinned(
  port: number,
  pin: string,
  path: string,
  init: { method?: string; body?: string; token?: string; origin: string },
) {
  return new Promise<{ status: number; json: unknown }>((resolve, reject) => {
    let settled = false
    let socket: tls.TLSSocket | undefined
    let timer: NodeJS.Timeout
    const finish = (error: Error | undefined, value?: { status: number; json: unknown }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(value!)
    }
    timer = setTimeout(() => {
      socket?.destroy()
      finish(new Error('The pinned connection timed out.'))
    }, 8000)
    socket = tls.connect({
      host: '127.0.0.1',
      port,
      servername: 'huddle',
      rejectUnauthorized: false,
    })
    socket.once('error', (error) => finish(error))
    socket.once('secureConnect', () => {
      const current = socket
      if (!current) return
      const raw = current.getPeerCertificate(true).raw
      if (!raw || pinCertificate(raw) !== pin) {
        finish(new Error('Server key does not match the invite.'))
        current.destroy()
        return
      }
      const method = init.method ?? 'GET'
      const head = [
        `${method} ${path} HTTP/1.1`,
        `host: 127.0.0.1:${port}`,
        `origin: ${init.origin}`,
        'content-type: application/json',
        'x-huddle-client: native',
        'connection: close',
        ...(init.token ? [`authorization: Bearer ${init.token}`] : []),
        ...(init.body ? [`content-length: ${Buffer.byteLength(init.body)}`] : []),
        '',
        '',
      ].join('\r\n')
      const chunks: Buffer[] = []
      const take = () => Buffer.concat(chunks)
      current.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
        const parsed = readHttp(take(), false)
        if (!parsed) return
        current.end()
        finish(undefined, parsed)
      })
      current.once('end', () => {
        const parsed = readHttp(take(), true)
        if (parsed) finish(undefined, parsed)
        else finish(new Error('The pinned connection closed before a response.'))
      })
      current.write(head)
      if (init.body) current.write(init.body)
    })
  })
}

async function assertPinCheck() {
  const identity = await loadIdentity('/tmp/huddle-friend-pin')
  const server = createServer({ key: identity.key, cert: identity.certificate }, (_req, res) => {
    res.end('ok')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Pin test did not bind.')
  const right = await pinned(address.port, identity.pin, '/', { origin: 'http://127.0.0.1' })
  assert.equal(right.status, 200)
  await assert.rejects(
    pinned(address.port, wrongPin(identity.pin), '/', { origin: 'http://127.0.0.1' }),
    /does not match/,
  )
  server.close()
  console.log('pin: swapped certificate rejected')
}

async function accounts() {
  if (!process.env.DATABASE_URL || !process.env.BETTER_AUTH_SECRET) {
    console.log('accounts skipped: DATABASE_URL is not set')
    return
  }
  const port = 3510
  const friendPort = 4510
  const database = await migratedDatabase()
  await rm(`${serverRoot}/data/friend/${friendPort}`, { recursive: true, force: true })
  let server: Awaited<ReturnType<typeof startServer>> | undefined
  try {
    server = await startServer({
      databaseUrl: database.url,
      port,
      entry: 'runtime/friend-test.ts',
      env: {
        SETUP_CODE: 'ABCD2345',
        FRIEND_PORT: String(friendPort),
        HUDDLE_INVITE_LOOPBACK: '1',
      },
    })
    const origin = server.origin
    const info = await pinned(friendPort, await diskPin(friendPort), '/api/info', { origin })
    assert.equal(info.status, 200)
    const setup = await pinned(friendPort, await diskPin(friendPort), '/api/access', {
      origin,
      method: 'POST',
      body: JSON.stringify({
        kind: 'account.setup',
        code: 'ABCD2345',
        serverName: 'Friends',
        username: 'ada',
        password: 'friend-pass-1',
      }),
    })
    const ada = AccessView.parse(setup.json)
    assert.equal(ada.stage.kind, 'ready')
    assert.ok(ada.bearerToken)
    const invites = FriendInvites.parse(
      (
        await pinned(friendPort, await diskPin(friendPort), '/api/friend-invite', {
          origin,
          token: ada.bearerToken,
        })
      ).json,
    )
    const local = invites.invites.map((line) => parseInvite(line)).find((invite) => invite.host === '127.0.0.1')
    assert.ok(local)
    await assert.rejects(
      pinned(friendPort, wrongPin(local.pin), '/api/info', { origin }),
      /does not match/,
    )
    const joined = AccessView.parse(
      (
        await pinned(friendPort, local.pin, '/api/access', {
          origin,
          method: 'POST',
          body: JSON.stringify({
            kind: 'account.join',
            code: local.code,
            username: 'bob',
            password: 'friend-pass-2',
          }),
        })
      ).json,
    )
    assert.equal(joined.stage.kind, 'ready')
    const room = Room.parse(
      (
        await pinned(friendPort, local.pin, '/api/rooms', {
          origin,
          method: 'POST',
          token: ada.bearerToken,
          body: JSON.stringify({ name: 'Friends' }),
        })
      ).json,
    )
    const channel = Channel.parse(
      (
        await pinned(friendPort, local.pin, '/api/channels', {
          origin,
          method: 'POST',
          token: ada.bearerToken,
          body: JSON.stringify({ roomId: room.id, name: 'general' }),
        })
      ).json,
    )
    const sent = Message.parse(
      (
        await pinned(friendPort, local.pin, '/api/messages', {
          origin,
          method: 'POST',
          token: ada.bearerToken,
          body: JSON.stringify({
            channelId: channel.id,
            retryId: randomUUID(),
            body: 'hello from ada',
          }),
        })
      ).json,
    )
    const seen = Message.array().parse(
      (
        await pinned(friendPort, local.pin, `/api/messages?channelId=${channel.id}`, {
          origin,
          token: joined.bearerToken,
        })
      ).json,
    )
    assert.equal(seen.at(-1)?.body, sent.body)
    await server.stop()
    await server.start()
    const after = Message.array().parse(
      (
        await pinned(friendPort, local.pin, `/api/messages?channelId=${channel.id}`, {
          origin,
          token: ada.bearerToken,
        })
      ).json,
    )
    assert.equal(after.at(-1)?.body, 'hello from ada')
    console.log('accounts: two friends exchanged a message that survived restart')
  } finally {
    await server?.stop()
    await database.drop()
    await rm(`${serverRoot}/data/friend/${friendPort}`, { recursive: true, force: true })
  }
}

async function diskPin(port: number) {
  const { readFile } = await import('node:fs/promises')
  const pem = await readFile(`${serverRoot}/data/friend/${port}/cert.pem`, 'utf8')
  const raw = Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, ''), 'base64')
  return pinCertificate(raw)
}

await assertPinCheck()
await accounts()
console.log('friend connect check passed')
