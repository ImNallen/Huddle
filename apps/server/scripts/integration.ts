import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { TOTP } from 'otpauth'
import { WebSocket } from 'ws'
import pg from 'pg'
import {
  AccessView,
  Channel,
  DeviceCode,
  DeviceToken,
  EventPage,
  Message,
  Session,
  Snapshot,
  Workspace,
  type WorkspaceEvent,
} from '@huddle/contracts'

const port = Number(process.env.TEST_PORT ?? 3100)
const socketPort = port + 1
const origin = `http://localhost:${port}`
const wsURL = `ws://localhost:${socketPort}`
let server: ChildProcess | undefined
let logs = ''
const sockets = new Set<WebSocket>()
async function start() {
  logs = ''
  server = spawn(process.execPath, ['--import', 'tsx', 'runtime/production.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: process.env.SMTP_SECURITY === 'local' ? 'development' : 'test',
      PORT: String(port),
      WS_PORT: String(socketPort),
      SERVER_URL: origin,
      WS_PUBLIC_URL: wsURL,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout?.on('data', (chunk: Buffer) => {
    logs += chunk.toString()
  })
  server.stderr?.on('data', (chunk: Buffer) => {
    logs += chunk.toString()
  })
  for (let attempt = 0; attempt < 80; attempt++) {
    if (server.exitCode !== null) throw new Error(`Server exited. ${logs}`)
    try {
      if ((await fetch(`${origin}/api/health`)).ok) return
    } catch {}
    await delay(125)
  }
  throw new Error(`Server startup timed out. ${logs}`)
}
async function stop() {
  if (!server || server.exitCode !== null) return
  const exited = once(server, 'exit')
  server.kill('SIGTERM')
  await exited
  server = undefined
}
async function request(
  path: string,
  {
    token,
    cookie,
    body,
    requestOrigin = origin,
  }: { token?: string; cookie?: string; body?: unknown; requestOrigin?: string } = {},
) {
  const headers = new Headers({ 'Content-Type': 'application/json', Origin: requestOrigin })
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (cookie) headers.set('Cookie', cookie)
  const response = await fetch(origin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data: unknown = await response.json()
  return { response, data }
}
async function call<T>(path: string, schema: z.ZodType<T>, token?: string, body?: unknown) {
  const { response, data } = await request(path, { token, body })
  assert.equal(response.status, 200, `${path}: ${JSON.stringify(data)}`)
  return schema.parse(data)
}
async function signup(name: string) {
  const email = `${randomUUID()}@huddle.test`
  let cookie = ''
  async function act(body: unknown) {
    const result = await request('/api/access', { cookie, body })
    assert.equal(result.response.status, 200, 'Passwordless signup failed')
    const updates = result.response.headers
      .getSetCookie()
      .map((header) => header.split(';')[0])
      .filter((value): value is string => Boolean(value))
    const jar = new Map(
      cookie
        .split('; ')
        .filter(Boolean)
        .map((pair) => {
          const index = pair.indexOf('=')
          return [pair.slice(0, index), pair.slice(index + 1)]
        }),
    )
    for (const pair of updates) {
      const index = pair.indexOf('=')
      jar.set(pair.slice(0, index), pair.slice(index + 1))
    }
    cookie = [...jar].map(([key, value]) => `${key}=${value}`).join('; ')
    return AccessView.parse(result.data)
  }
  await act({ kind: 'email.send', email })
  const mailpit = process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025'
  const messages = z
    .object({
      messages: z.array(
        z.object({ ID: z.string(), To: z.array(z.object({ Address: z.string() })) }),
      ),
    })
    .parse(await (await fetch(`${mailpit}/api/v1/messages`)).json())
  const message = messages.messages.find((message) => message.To.some((to) => to.Address === email))
  assert(message, 'SMTP must deliver the integration signup code')
  const mail = z
    .object({ Text: z.string() })
    .parse(await (await fetch(`${mailpit}/api/v1/message/${message.ID}`)).json())
  const code = mail.Text.match(/\b\d{6}\b/)?.[0]
  assert(code)
  let view = await act({ kind: 'email.verify', code })
  assert(view.stage.kind === 'enroll')
  view = await act({
    kind: 'enrollment.verify',
    generation: view.stage.generation,
    code: new TOTP({
      secret: view.stage.secret,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
    }).generate(),
  })
  assert(view.stage.kind === 'save-recovery')
  await act({ kind: 'recovery.ack', batch: view.stage.batch })
  await act({ kind: 'passkey.skip' })
  view = await act({
    kind: 'profile.save',
    profile: { name, avatar: { kind: 'mascot', shape: 'circle', color: 'indigo' } },
  })
  assert(view.stage.kind === 'ready')
  const encoded = cookie
    .split('; ')
    .find((pair) => pair.includes('session_token='))
    ?.split('=')
    .slice(1)
    .join('=')
  assert(encoded)
  const token = decodeURIComponent(encoded)
  return { token, cookie, user: view.stage.user }
}

function watch(token: string, workspaceId: string, after: string, ticket?: string) {
  const socket = new WebSocket(wsURL, { origin })
  sockets.add(socket)
  const events: WorkspaceEvent[] = []
  let ready = false
  socket.on('open', () =>
    socket.send(
      JSON.stringify({ kind: 'watch', workspaceId, after, ...(ticket ? { ticket } : { token }) }),
    ),
  )
  socket.on('message', (data) => {
    events.push(...EventPage.parse(JSON.parse(data.toString())).events)
    ready = true
  })
  socket.on('close', () => sockets.delete(socket))
  socket.on('error', () => {})
  return {
    socket,
    events,
    get ready() {
      return ready
    },
  }
}
async function eventually(predicate: () => boolean, message: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await delay(100)
  }
  assert.ok(predicate(), message)
}
async function rejectedFrame(frame: unknown, expected = 1008) {
  const socket = new WebSocket(wsURL, { origin })
  sockets.add(socket)
  socket.on('error', () => {})
  const closed = once(socket, 'close')
  await once(socket, 'open')
  socket.send(JSON.stringify(frame))
  const [code] = await closed
  sockets.delete(socket)
  assert.equal(code, expected)
}
function pass(message: string) {
  process.stdout.write(`PASS ${message}\n`)
}
try {
  await start()
  assert.equal((await request('/api/workspaces')).response.status, 401)
  assert.equal(
    (await request('/api/workspaces', { body: { name: 'anonymous' } })).response.status,
    401,
  )
  pass('anonymous requests cannot read or create workspaces')
  const owner = await signup('Integration owner')
  const member = await signup('Integration colleague')
  assert.deepEqual(await call('/api/workspaces', Workspace.array(), member.token), [])
  const workspace = await call('/api/workspaces', Workspace, owner.token, {
    name: 'Integration studio',
  })
  const other = await call('/api/workspaces', Workspace, member.token, { name: 'Other studio' })
  assert.equal(
    (await request(`/api/snapshot?workspaceId=${workspace.id}`, { token: member.token })).response
      .status,
    403,
  )
  assert.equal(
    (await request(`/api/snapshot?workspaceId=${other.id}`, { token: owner.token })).response
      .status,
    403,
  )
  const channel = await call('/api/channels', Channel, owner.token, {
    workspaceId: workspace.id,
    name: 'general',
  })
  assert.equal(
    (
      await request('/api/messages', {
        token: member.token,
        body: { channelId: channel.id, retryId: randomUUID(), body: 'forbidden' },
      })
    ).response.status,
    403,
  )
  pass('accounts have no implicit membership and workspaces are isolated')
  const invitation = await call('/api/invitations', z.object({ code: z.string() }), owner.token, {
    workspaceId: workspace.id,
  })
  await call('/api/invitations/redeem', Workspace, member.token, { code: invitation.code })
  assert.equal(
    (
      await request('/api/invitations/redeem', {
        token: member.token,
        body: { code: invitation.code },
      })
    ).response.status,
    404,
  )
  assert.equal(
    (
      await request('/api/channels', {
        token: member.token,
        body: { workspaceId: workspace.id, name: 'forbidden' },
      })
    ).response.status,
    403,
  )
  assert.equal(
    (
      await request('/api/invitations', {
        token: member.token,
        body: { workspaceId: workspace.id },
      })
    ).response.status,
    403,
  )
  pass('one-use invitations grant membership without granting ownership')
  const snapshot = await call(`/api/snapshot?workspaceId=${workspace.id}`, Snapshot, owner.token)
  const first = watch(owner.token, workspace.id, snapshot.cursor)
  const ticket = await call('/api/watch-ticket', z.object({ ticket: z.string() }), member.token, {})
  const second = watch('', workspace.id, snapshot.cursor, ticket.ticket)
  await eventually(() => first.ready && second.ready, 'Both clients are subscribed')
  await rejectedFrame({
    kind: 'watch',
    workspaceId: workspace.id,
    after: snapshot.cursor,
    ticket: ticket.ticket,
  })
  const input = {
    channelId: channel.id,
    retryId: randomUUID(),
    body: 'A real persistent conversation.',
  }
  const [message, duplicate] = await Promise.all([
    call('/api/messages', Message, owner.token, input),
    call('/api/messages', Message, owner.token, input),
  ])
  assert.deepEqual(message, duplicate)
  await eventually(
    () =>
      first.events.some(
        (event) => event.kind === 'message.created' && event.message.id === message.id,
      ) &&
      second.events.some(
        (event) => event.kind === 'message.created' && event.message.id === message.id,
      ),
    'Both clients receive the durable message',
  )
  assert.equal(
    (await request('/api/messages', { token: owner.token, body: { ...input, body: 'Changed' } }))
      .response.status,
    409,
  )
  const anotherChannel = await call('/api/channels', Channel, owner.token, {
    workspaceId: workspace.id,
    name: 'design',
  })
  assert.equal(
    (
      await request('/api/messages', {
        token: owner.token,
        body: { ...input, channelId: anotherChannel.id },
      })
    ).response.status,
    409,
  )
  const history = await call(`/api/messages?channelId=${channel.id}`, Message.array(), owner.token)
  assert.equal(history.filter((item) => item.retryId === input.retryId).length, 1)
  pass('two clients receive committed messages; exact retries deduplicate and conflicts reject')
  const fixture = new pg.Client({ connectionString: z.string().parse(process.env.DATABASE_URL) })
  await fixture.connect()
  let silentMessage: Message
  try {
    await fixture.query('BEGIN')
    await fixture.query('SELECT id FROM workspace WHERE id = $1 FOR UPDATE', [workspace.id])
    const row = await fixture.query<Record<string, unknown>>(
      'UPDATE workspace SET cursor = cursor + 1 WHERE id = $1 RETURNING cursor::text',
      [workspace.id],
    )
    const { cursor } = z.object({ cursor: z.string() }).parse(row.rows[0])
    silentMessage = Message.parse({
      id: randomUUID(),
      channelId: channel.id,
      authorId: owner.user.id,
      authorName: 'Integration owner',
      retryId: randomUUID(),
      body: 'Committed with the wakeup deliberately omitted.',
      cursor,
      createdAt: new Date().toISOString(),
    })
    await fixture.query(
      'INSERT INTO message(id, channel_id, author_id, author_name, retry_id, body, cursor, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        silentMessage.id,
        silentMessage.channelId,
        silentMessage.authorId,
        silentMessage.authorName,
        silentMessage.retryId,
        silentMessage.body,
        silentMessage.cursor,
        silentMessage.createdAt,
      ],
    )
    await fixture.query(
      'INSERT INTO workspace_event(workspace_id, cursor, event) VALUES ($1,$2,$3)',
      [workspace.id, cursor, { kind: 'message.created', message: silentMessage, cursor }],
    )
    await fixture.query('COMMIT')
  } catch (error) {
    await fixture.query('ROLLBACK')
    throw error
  } finally {
    await fixture.end()
  }
  await eventually(
    () =>
      first.events.some(
        (event) => event.kind === 'message.created' && event.message.id === silentMessage.id,
      ) &&
      second.events.some(
        (event) => event.kind === 'message.created' && event.message.id === silentMessage.id,
      ),
    'Connected watches recover a committed message without a notification',
  )
  pass('database polling recovers an intentionally omitted notification without reconnecting')

  const cursor = message.cursor
  second.socket.close()
  const offline = await call('/api/messages', Message, owner.token, {
    channelId: channel.id,
    retryId: randomUUID(),
    body: 'Sent while a client was disconnected.',
  })
  const offlineChannel = await call('/api/channels', Channel, owner.token, {
    workspaceId: workspace.id,
    name: 'replay',
  })
  const reconnected = watch(member.token, workspace.id, cursor)
  await eventually(
    () =>
      reconnected.events.some(
        (event) => event.kind === 'message.created' && event.message.id === offline.id,
      ) &&
      reconnected.events.some(
        (event) => event.kind === 'channel.created' && event.channel.id === offlineChannel.id,
      ),
    'Replay includes messages and channels created offline',
  )
  const beforeOverlap = await call(
    `/api/snapshot?workspaceId=${workspace.id}`,
    Snapshot,
    owner.token,
  )
  const overlap = await call('/api/messages', Message, owner.token, {
    channelId: channel.id,
    retryId: randomUUID(),
    body: 'Between snapshot and watch.',
  })
  const racing = watch(owner.token, workspace.id, beforeOverlap.cursor)
  await eventually(
    () =>
      racing.events.some(
        (event) => event.kind === 'message.created' && event.message.id === overlap.id,
      ),
    'Snapshot/watch overlap is recovered',
  )
  await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      call('/api/messages', Message, owner.token, {
        channelId: channel.id,
        retryId: randomUUID(),
        body: `Concurrent ${index}`,
      }),
    ),
  )
  await eventually(
    () => racing.events.filter((event) => event.kind === 'message.created').length === 13,
    'All concurrent messages arrive',
  )
  const cursors = racing.events.map((event) => BigInt(event.cursor))
  for (let index = 1; index < cursors.length; index++)
    assert.equal(cursors[index], (cursors[index - 1] ?? 0n) + 1n)
  pass('offline replay, snapshot overlap, polling recovery, and concurrent cursor order')
  await rejectedFrame({ kind: 'send', body: 'socket cannot mutate' })
  await rejectedFrame({
    kind: 'watch',
    workspaceId: workspace.id,
    after: '0',
    token: 'invalid-session',
  })
  await rejectedFrame({ kind: 'watch', workspaceId: other.id, after: '0', token: owner.token })
  assert.equal(
    (
      await request('/api/messages', {
        token: owner.token,
        requestOrigin: 'https://untrusted.test',
        body: input,
      })
    ).response.status,
    403,
  )
  assert.equal(
    (await request('/api/messages', { token: owner.token, body: { ...input, body: '' } })).response
      .status,
    400,
  )
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(wsURL, { origin: 'https://untrusted.test' })
    socket.on('unexpected-response', (_request, response) => {
      assert.equal(response.statusCode, 403)
      response.resume()
      socket.terminate()
      resolve()
    })
    socket.on('open', () => {
      socket.terminate()
      reject(new Error('Untrusted origin connected'))
    })
    socket.on('error', () => {})
  })
  assert.equal(
    (await request('/api/workspaces', { token: owner.token, requestOrigin: 'tauri://localhost' }))
      .response.status,
    200,
  )
  assert.equal(
    (
      await request('/api/workspaces', {
        token: owner.token,
        requestOrigin: 'http://tauri.localhost',
      })
    ).response.status,
    200,
  )
  pass('malformed frames, invalid sessions, unauthorized watches, and untrusted origins reject')
  const device = await call('/api/auth/device/code', DeviceCode, undefined, {
    client_id: 'huddle-desktop',
  })
  const pendingBody = {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: device.device_code,
    client_id: 'huddle-desktop',
  }
  const pending = await request('/api/auth/device/token', { body: pendingBody })
  assert.equal(z.object({ error: z.string() }).parse(pending.data).error, 'authorization_pending')
  const slow = await request('/api/auth/device/token', { body: pendingBody })
  assert.equal(z.object({ error: z.string() }).parse(slow.data).error, 'slow_down')
  const claim = await request(
    `/api/auth/device?user_code=${encodeURIComponent(device.user_code)}`,
    { cookie: owner.cookie },
  )
  assert.equal(claim.response.status, 200, JSON.stringify(claim.data))
  assert.equal(z.object({ client_id: z.string() }).parse(claim.data).client_id, 'huddle-desktop')
  const hijack = await request('/api/auth/device/approve', {
    cookie: member.cookie,
    body: { userCode: device.user_code },
  })
  assert.ok(!hijack.response.ok)
  const approved = await request('/api/auth/device/approve', {
    cookie: owner.cookie,
    body: { userCode: device.user_code },
  })
  assert.equal(approved.response.status, 200, JSON.stringify(approved.data))
  await delay((device.interval + 5) * 1000 + 100)
  const deviceToken = await call('/api/auth/device/token', DeviceToken, undefined, pendingBody)
  const deviceSession = await call('/api/auth/get-session', Session, deviceToken.access_token)
  assert.equal(deviceSession.user.id, owner.user.id)
  pass('passwordless device claim, explicit approval, slow_down, and bearer session')
  await call('/api/auth/sign-out', z.unknown(), member.token, {})
  await eventually(
    () => reconnected.socket.readyState === WebSocket.CLOSED,
    'A revoked session cannot keep watching',
  )
  assert.equal((await request('/api/workspaces', { token: member.token })).response.status, 401)
  pass('session revocation closes an existing watch and denies subsequent HTTP reads')
  for (const socket of sockets) socket.terminate()
  await stop()
  await start()
  const persisted = await call(
    `/api/messages?channelId=${channel.id}`,
    Message.array(),
    owner.token,
  )
  assert.ok(persisted.some((item) => item.id === offline.id))
  const restarted = watch(owner.token, workspace.id, cursor)
  await eventually(
    () =>
      restarted.events.some(
        (event) => event.kind === 'message.created' && event.message.id === offline.id,
      ),
    'Events survive a server restart',
  )
  pass('messages, sessions, and durable replay survive an actual server restart')
} catch (error) {
  process.stderr.write(logs)
  throw error
} finally {
  for (const socket of sockets) socket.terminate()
  await stop()
}
