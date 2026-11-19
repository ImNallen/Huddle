import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'
import pg from 'pg'
import { RoomServiceClient } from 'livekit-server-sdk'
import { z } from 'zod'
import {
  DirectCall,
  DirectConversation,
  EventPage,
  ServerInfo,
  VoiceGrant,
} from '@huddle/contracts'
import {
  Client,
  migratedDatabase,
  startServer,
  setupFriend,
  joinFriend,
  inviteCode,
  tailscale,
  runningLivekit,
} from './harness'
import { LegacyEventPage } from './legacy-contracts'

const livekit = await runningLivekit()
let holdParticipants: { arrived: () => void; released: Promise<void> } | null = null
let releaseParticipants = () => {}
const proxy = createServer(async (request, response) => {
  try {
    if (request.url?.endsWith('/ListParticipants') && holdParticipants) {
      const held = holdParticipants
      holdParticipants = null
      held.arrived()
      await held.released
    }
    const body: Buffer[] = []
    for await (const chunk of request) body.push(Buffer.from(chunk))
    const upstream = await fetch(`${livekit.http}${request.url}`, {
      method: request.method,
      headers: {
        authorization: request.headers.authorization ?? '',
        'content-type': request.headers['content-type'] ?? 'application/json',
      },
      body: Buffer.concat(body),
    })
    response.writeHead(upstream.status, Object.fromEntries(upstream.headers))
    response.end(Buffer.from(await upstream.arrayBuffer()))
  } catch {
    response.writeHead(502).end()
  }
})
proxy.listen(0, '127.0.0.1')
await once(proxy, 'listening')
const proxyAddress = proxy.address()
assert.ok(proxyAddress && typeof proxyAddress !== 'string')
const database = await migratedDatabase()
const code = randomUUID()
const server = await startServer({
  databaseUrl: database.url,
  port: Number(process.env.DIRECT_CALL_TEST_PORT ?? 4100),
  env: {
    SETUP_CODE: code,
    LIVEKIT_PORT: String(proxyAddress.port),
    LIVEKIT_PUBLIC_URL: livekit.url,
    DIRECT_CALL_RING_SECONDS: '2',
    DIRECT_CALL_JOIN_SECONDS: '2',
    VOICE_ACCESS_GRACE_SECONDS: '3',
  },
})
const sql = new pg.Client({ connectionString: database.url })
await sql.connect()
const service = new RoomServiceClient(livekit.http, livekit.key, livekit.secret)
const sockets = new Set<WebSocket>()
async function call<T>(client: Client, path: string, schema: z.ZodType<T>, body?: unknown) {
  const answer = await client.call(path, body)
  assert.equal(answer.response.status, 200, `${path}: ${JSON.stringify(answer.value)}`)
  return schema.parse(answer.value)
}
async function eventually(check: () => Promise<boolean> | boolean, label: string) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return
    await delay(50)
  }
  assert.ok(await check(), label)
}
function watch(client: Client) {
  const socket = new WebSocket(server.websocket, {
    origin: server.origin,
    headers: tailscale(z.string().parse(client.login)),
  })
  sockets.add(socket)
  const frames: z.infer<typeof EventPage>[] = []
  socket.on('open', () => socket.send(JSON.stringify({ kind: 'watch', after: '0' })))
  socket.on('message', (raw) => {
    const json: unknown = JSON.parse(raw.toString())
    LegacyEventPage.parse(json)
    frames.push(EventPage.parse(json))
  })
  socket.on('error', () => {})
  return {
    frames,
    close: () => {
      socket.terminate()
      sockets.delete(socket)
    },
    latest: () => frames.at(-1)?.directCall,
  }
}
try {
  const a = new Client(server.origin, 'calls-a@huddle.test'),
    b = new Client(server.origin, 'calls-b@huddle.test'),
    c = new Client(server.origin, 'calls-c@huddle.test')
  const alice = await setupFriend(a, { code, serverName: 'Private calls', name: 'Alice' })
  const invite = await inviteCode(a)
  const bob = await joinFriend(b, invite, 'Bob')
  await joinFriend(c, invite, 'Cal')
  const ab = await call(a, '/api/direct/conversations', DirectConversation, { userId: bob.id })
  const ac = await call(c, '/api/direct/conversations', DirectConversation, { userId: alice.id })
  assert.equal((await call(a, '/api/info', ServerInfo)).directCalls, true)
  assert.equal(
    ServerInfo.parse({
      name: 'old',
      setup: 'complete',
      serverUrl: server.origin,
      websocketUrl: server.websocket,
    }).directCalls,
    false,
  )
  const aw = watch(a),
    bw = watch(b),
    cw = watch(c)
  await eventually(() => cw.frames.length > 0, 'outsider watch connected')
  const start = { callId: randomUUID(), conversationId: ab.id }
  const ringing = await call(a, '/api/direct/calls/start', DirectCall, start)
  assert.equal(ringing.state, 'ringing')
  assert.deepEqual(await call(a, '/api/direct/calls/start', DirectCall, start), ringing)
  assert.equal(
    (await a.call('/api/direct/calls/start', { ...start, extra: true })).response.status,
    400,
  )
  await eventually(
    () => bw.latest()?.id === ringing.id,
    'recipient sees an empty-conversation call',
  )
  const outsider = await c.call('/api/direct/calls/accept', { callId: ringing.id })
  const unknown = await c.call('/api/direct/calls/accept', { callId: randomUUID() })
  assert.equal(outsider.response.status, 404)
  assert.deepEqual(outsider.value, unknown.value)
  for (const suffix of ['accept', 'token', 'end']) {
    const body = { callId: ringing.id, ...(suffix === 'end' ? { action: 'hangup' } : {}) }
    const bad = await c.call(`/api/direct/calls/${suffix}`, body)
    assert.equal(bad.response.status, 404)
  }
  assert.equal(
    (await a.call('/api/direct/calls/accept', { callId: ringing.id })).response.status,
    409,
  )
  assert.equal(
    (await b.call('/api/direct/calls/token', { callId: ringing.id })).response.status,
    409,
  )
  assert.equal(
    (await b.call('/api/direct/calls/start', { callId: randomUUID(), conversationId: ab.id }))
      .response.status,
    409,
  )
  assert.equal(
    (await c.call('/api/direct/calls/start', { callId: randomUUID(), conversationId: ac.id }))
      .response.status,
    409,
  )
  const accepted = await call(b, '/api/direct/calls/accept', DirectCall, { callId: ringing.id })
  assert.equal(accepted.state, 'accepted')
  assert.ok(accepted.revision > ringing.revision)
  assert.deepEqual(
    await call(b, '/api/direct/calls/accept', DirectCall, { callId: ringing.id }),
    accepted,
  )
  const grant = await call(a, '/api/direct/calls/token', VoiceGrant, { callId: ringing.id })
  const payload = z
    .object({
      video: z.object({ room: z.string(), canPublishSources: z.array(z.string()) }),
      exp: z.number(),
    })
    .parse(JSON.parse(Buffer.from(grant.token.split('.')[1] ?? '', 'base64url').toString()))
  assert.deepEqual(payload.video.canPublishSources, ['microphone'])
  assert.ok(payload.video.room.startsWith('direct-'))
  assert.notEqual(payload.video.room, `direct-${ringing.id}`)
  assert.ok((await fetch(`${livekit.http}/rtc/validate?access_token=${grant.token}`)).ok)
  await service.createRoom({ name: payload.video.room })
  await delay(1100)
  assert.ok(cw.frames.every((frame) => !JSON.stringify(frame).includes(ringing.id)))
  assert.ok(aw.frames.every((frame) => !JSON.stringify(frame.voice).includes('direct-')))
  const ended = await call(a, '/api/direct/calls/end', DirectCall, {
    callId: ringing.id,
    action: 'hangup',
  })
  assert.equal(ended.state, 'ended')
  assert.deepEqual(
    await call(a, '/api/direct/calls/end', DirectCall, { callId: ringing.id, action: 'hangup' }),
    ended,
  )
  assert.equal(
    (await a.call('/api/direct/calls/token', { callId: ringing.id })).response.status,
    409,
  )
  await eventually(
    async () => !(await service.listRooms()).some((r) => r.name === payload.video.room),
    'ended room closed',
  )
  await sql.query(
    "UPDATE direct_call SET token_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [ringing.id],
  )
  await service.createRoom({ name: payload.video.room })
  await eventually(
    async () => !(await service.listRooms()).some((r) => r.name === payload.video.room),
    'room recreated after the original token expiry is still closed',
  )
  for (const action of ['decline', 'cancel'] as const) {
    const attempt = await call(a, '/api/direct/calls/start', DirectCall, {
      callId: randomUUID(),
      conversationId: ab.id,
    })
    const actor = action === 'decline' ? b : a
    const terminal = await call(actor, '/api/direct/calls/end', DirectCall, {
      callId: attempt.id,
      action,
    })
    assert.equal(terminal.state, 'ended')
    assert.deepEqual(
      await call(actor, '/api/direct/calls/end', DirectCall, { callId: attempt.id, action }),
      terminal,
    )
    assert.equal(
      (await call(b, '/api/direct/calls/accept', DirectCall, { callId: attempt.id })).state,
      'ended',
    )
  }
  const timeout = await call(a, '/api/direct/calls/start', DirectCall, {
    callId: randomUUID(),
    conversationId: ab.id,
  })
  await eventually(
    () => bw.latest()?.id === timeout.id && bw.latest()?.state === 'ended',
    'ringing timeout',
  )
  const joining = await call(a, '/api/direct/calls/start', DirectCall, {
    callId: randomUUID(),
    conversationId: ab.id,
  })
  await call(b, '/api/direct/calls/accept', DirectCall, { callId: joining.id })
  await eventually(
    () => bw.latest()?.id === joining.id && bw.latest()?.state === 'ended',
    'accepted join timeout',
  )
  const race = await call(a, '/api/direct/calls/start', DirectCall, {
    callId: randomUUID(),
    conversationId: ab.id,
  })
  await Promise.all([
    b.call('/api/direct/calls/accept', { callId: race.id }),
    a.call('/api/direct/calls/end', { callId: race.id, action: 'cancel' }),
  ])
  assert.equal(
    (
      await call(a, '/api/direct/calls/start', DirectCall, {
        callId: race.id,
        conversationId: ab.id,
      })
    ).state,
    'ended',
  )
  const crossed = await Promise.all([
    a.call('/api/direct/calls/start', { callId: randomUUID(), conversationId: ab.id }),
    b.call('/api/direct/calls/start', { callId: randomUUID(), conversationId: ab.id }),
  ])
  assert.deepEqual(crossed.map((answer) => answer.response.status).sort(), [200, 409])
  const winner = DirectCall.parse(crossed.find((answer) => answer.response.status === 200)?.value)
  await call(winner.callerId === alice.id ? a : b, '/api/direct/calls/end', DirectCall, {
    callId: winner.id,
    action: 'cancel',
  })
  const stalled = await call(a, '/api/direct/calls/start', DirectCall, {
    callId: randomUUID(),
    conversationId: ab.id,
  })
  await call(b, '/api/direct/calls/accept', DirectCall, { callId: stalled.id })
  const stalledRoom = z
    .string()
    .parse(
      (await sql.query('SELECT room_name FROM direct_call WHERE id=$1', [stalled.id])).rows[0]
        ?.room_name,
    )
  await service.createRoom({ name: stalledRoom })
  const arrived = new Promise<void>((resolve) => {
    const released = new Promise<void>((release) => {
      releaseParticipants = release
    })
    holdParticipants = { arrived: resolve, released }
  })
  await arrived
  try {
    const hangup = await Promise.race([
      a.call('/api/direct/calls/end', { callId: stalled.id, action: 'hangup' }),
      delay(1000).then(() => null),
    ])
    assert.ok(hangup, 'hangup must complete while the LiveKit admin request remains held')
    assert.equal(hangup.response.status, 200)
    assert.equal(DirectCall.parse(hangup.value).state, 'ended')
  } finally {
    releaseParticipants()
  }
  await eventually(
    async () => !(await service.listRooms()).some((r) => r.name === stalledRoom),
    'ended room closes after the held admin request resumes',
  )
  const watched = await call(a, '/api/direct/calls/start', DirectCall, {
    callId: randomUUID(),
    conversationId: ab.id,
  })
  await call(b, '/api/direct/calls/accept', DirectCall, { callId: watched.id })
  const watchedRoom = z
    .string()
    .parse(
      (await sql.query('SELECT room_name FROM direct_call WHERE id=$1', [watched.id])).rows[0]
        ?.room_name,
    )
  for (const participant of [a, b]) {
    const ticket = await call(participant, '/api/direct/calls/token', VoiceGrant, {
      callId: watched.id,
    })
    const mediaSocket = new WebSocket(
      `${ticket.url}/rtc?access_token=${ticket.token}&auto_subscribe=1&sdk=js&version=2.0.0&protocol=15`,
    )
    sockets.add(mediaSocket)
    mediaSocket.on('error', () => {})
    await eventually(
      async () =>
        (await service.listParticipants(watchedRoom).catch(() => [])).some(
          (p) => p.identity === participant.userId,
        ),
      'private participant joins LiveKit',
    )
  }
  await eventually(
    async () =>
      (await sql.query('SELECT media_joined FROM direct_call WHERE id=$1', [watched.id])).rows[0]
        ?.media_joined === true,
    'both participants joined',
  )
  bw.close()
  await eventually(
    () => aw.latest()?.id === watched.id && aw.latest()?.state === 'ended',
    'watch access grace ends an active private call',
  )
  const accessEnded = aw.latest()
  assert.equal(accessEnded?.state === 'ended' && accessEnded.reason, 'access-lost')
  await eventually(
    async () => !(await service.listRooms()).some((r) => r.name === watchedRoom),
    'access loss closes private media',
  )
  const restarting = await call(a, '/api/direct/calls/start', DirectCall, {
    callId: randomUUID(),
    conversationId: ab.id,
  })
  await call(b, '/api/direct/calls/accept', DirectCall, { callId: restarting.id })
  const restartGrant = await call(b, '/api/direct/calls/token', VoiceGrant, {
    callId: restarting.id,
  })
  const restartRoom = z
    .object({ video: z.object({ room: z.string() }) })
    .parse(JSON.parse(Buffer.from(restartGrant.token.split('.')[1] ?? '', 'base64url').toString()))
    .video.room
  aw.close()
  bw.close()
  cw.close()
  await server.stop()
  await server.start()
  const restarted = await call(a, '/api/direct/calls/start', DirectCall, {
    callId: restarting.id,
    conversationId: ab.id,
  })
  assert.equal(restarted.state, 'ended')
  if (restarted.state === 'ended') assert.equal(restarted.reason, 'restart')
  await service.createRoom({ name: restartRoom })
  await eventually(
    async () => !(await service.listRooms()).some((r) => r.name === restartRoom),
    'restart keeps closing outstanding tokens',
  )
  const foreign = await service.createRoom({ name: `direct-${randomUUID()}` })
  try {
    const chosen = await call(a, '/api/direct/calls/start', DirectCall, {
      callId: foreign.name.slice(7),
      conversationId: ab.id,
    })
    await call(a, '/api/direct/calls/end', DirectCall, { callId: chosen.id, action: 'cancel' })
    await delay(1100)
    assert.ok((await service.listRooms()).some((r) => r.name === foreign.name))
  } finally {
    await service.deleteRoom(foreign.name)
  }
  const gone = await call(a, '/api/direct/calls/start', DirectCall, {
    callId: randomUUID(),
    conversationId: ab.id,
  })
  await call(b, '/api/direct/calls/accept', DirectCall, { callId: gone.id })
  await sql.query('DELETE FROM member WHERE user_id=$1', [bob.id])
  assert.equal((await a.call('/api/direct/calls/token', { callId: gone.id })).response.status, 404)
  await eventually(
    async () =>
      (await sql.query('SELECT state FROM direct_call WHERE id=$1', [gone.id])).rows[0]?.state ===
      'ended',
    'removal ends signaling',
  )
  process.stdout.write('Direct calls API checks passed.\n')
} finally {
  releaseParticipants()
  for (const socket of sockets) socket.terminate()
  await server.stop()
  await sql.end()
  await database.drop()
  proxy.closeAllConnections()
  await new Promise<void>((resolve, reject) =>
    proxy.close((error) => (error ? reject(error) : resolve())),
  )
}
