import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { WebSocket } from 'ws'
import pg from 'pg'
import sharp from 'sharp'
import {
  AccessError,
  type Avatar,
  Channel,
  DirectConversation,
  DirectMessage,
  EventPage,
  Members,
  Message,
  Room,
  ServerInfo,
  Snapshot,
  UserId,
  type ServerEvent,
} from '@huddle/contracts'
import { mentionedUsers } from '../src/lib/domain'
import { renewDelay } from '../src/lib/reach'
import {
  Client,
  friendCode,
  joinFriend,
  migratedDatabase,
  setupFriend,
  startServer,
} from './harness'

const setupCode = `integration-${randomUUID()}`
const database = await migratedDatabase()
const server = await startServer({
  databaseUrl: database.url,
  port: Number(process.env.TEST_PORT ?? 3100),
  env: { SETUP_CODE: setupCode, HUDDLE_INVITE_LOOPBACK: '1' },
}).catch(async (error: unknown) => {
  await database.drop()
  throw error
})
const origin = server.origin
const wsURL = server.websocket
const sockets = new Set<WebSocket>()
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
async function rawText(path: string, token: string, body?: unknown) {
  const response = await fetch(origin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      Authorization: `Bearer ${token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, text: await response.text() }
}
function account(client: Client, user: Awaited<ReturnType<typeof setupFriend>>) {
  return { token: client.sessionToken(), cookie: client.cookie(), user }
}

function watch(token: string, after: string, ticket?: string) {
  const socket = new WebSocket(wsURL, { origin })
  sockets.add(socket)
  const events: ServerEvent[] = []
  const frames: string[] = []
  let ready = false
  socket.on('open', () =>
    socket.send(JSON.stringify({ kind: 'watch', after, ...(ticket ? { ticket } : { token }) })),
  )
  socket.on('message', (data) => {
    frames.push(data.toString())
    events.push(...EventPage.parse(JSON.parse(data.toString())).events)
    ready = true
  })
  socket.on('close', () => sockets.delete(socket))
  socket.on('error', () => {})
  return {
    socket,
    events,
    frames,
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
async function accountReset(username: string, password: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/account-reset.ts', username], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, DATABASE_URL: database.url },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
  child.stdin.end(`${password}\n`)
  const [code] = await once(child, 'exit')
  return { code: z.number().parse(code), args: child.spawnargs, stdout, stderr }
}
async function watchedSession(token: string) {
  const cursor = (await call('/api/snapshot', Snapshot, token)).cursor
  const live = watch(token, cursor)
  await eventually(() => live.ready, 'the session watches before the reset')
  const { ticket } = await call('/api/watch-ticket', z.object({ ticket: z.string() }), token, {})
  return async function cutOff(label: string) {
    assert.equal((await request('/api/snapshot', { token })).response.status, 401, label)
    await eventually(() => live.socket.readyState === WebSocket.CLOSED, `${label}: watch closes`)
    await rejectedFrame({ kind: 'watch', after: cursor, ticket })
  }
}
function pass(message: string) {
  process.stdout.write(`PASS ${message}\n`)
}
try {
  const person = (id: string) => UserId.parse(id)
  const people = [
    { id: person('ana'), name: 'Ana Lind' },
    { id: person('bo'), name: 'Bo (QA) Berg' },
    { id: person('cy'), name: 'Annabel' },
    { id: person('dy'), name: 'Åsa Ek' },
    { id: person('jr'), name: 'J.R. Smith' },
  ]
  const mentions = (body: string, author: string) => mentionedUsers(body, people, person(author))
  assert.deepEqual(mentions('@ana can you look', 'bo'), ['ana'])
  assert.deepEqual(mentions('hi @ANA LIND!', 'bo'), ['ana'])
  assert.deepEqual(mentions('@anab and @annabelle', 'bo'), [])
  assert.deepEqual(mentions('mail ana@lind.test', 'bo'), [])
  assert.deepEqual(mentions('ping @bo (qa) berg', 'ana'), ['bo'])
  assert.deepEqual(mentions('(@Ana) and @annabel', 'ana'), ['cy'])
  assert.deepEqual(mentions('@åsa, @jxr', 'ana'), ['dy'])
  assert.deepEqual(mentions('@Åsab @j.r.', 'ana'), ['jr'])
  pass('mentions match a full or first name after @, escape names, and never include the author')
  assert.equal(renewDelay(3600), 1800)
  assert.equal(renewDelay(10), 5)
  assert.equal(renewDelay(1), 1)
  pass('a NAT mapping renews halfway through the lifetime the router granted')
  assert.equal((await request('/api/snapshot')).response.status, 401)
  assert.equal((await request('/api/rooms', { body: { name: 'anonymous' } })).response.status, 401)
  pass('anonymous requests cannot read the server or create rooms')

  const fresh = await call('/api/info', ServerInfo)
  assert.equal(fresh.setup, 'required')
  assert.equal(fresh.name, 'Huddle')
  const anonymous = new Client(origin)
  assert.equal((await anonymous.act({ kind: 'signout' })).stage.kind, 'setup')
  const wrong = await anonymous.call('/api/access', {
    kind: 'account.setup',
    code: 'not-the-setup-code',
    serverName: 'Integration studio',
    username: 'intruder',
    password: 'intruder-secret',
  })
  assert.equal(wrong.response.status, 400)
  assert.deepEqual(AccessError.parse(wrong.value), { error: 'invalid' })
  const ownerClient = new Client(origin)
  const ownerUser = await setupFriend(ownerClient, {
    code: setupCode,
    serverName: 'Integration studio',
    username: 'owner',
    password: 'owner-secret',
    name: 'Integration owner',
  })
  const owner = account(ownerClient, ownerUser)
  const named = await call('/api/info', ServerInfo)
  assert.equal(named.setup, 'complete')
  assert.equal(named.name, 'Integration studio')
  assert.equal((await new Client(origin).act({ kind: 'signout' })).stage.kind, 'signin')
  for (const code of [setupCode, 'a-brand-new-setup-code'])
    assert.equal(
      (
        await new Client(origin).call('/api/access', {
          kind: 'account.setup',
          code,
          serverName: 'Hijacked',
          username: 'intruder',
          password: 'intruder-secret',
        })
      ).response.status,
      400,
    )
  await server.stop()
  await server.start()
  assert.doesNotMatch(server.logs(), /Huddle setup/)
  assert.equal(
    (
      await new Client(origin).call('/api/access', {
        kind: 'account.setup',
        code: setupCode,
        serverName: 'Hijacked',
        username: 'intruder',
        password: 'intruder-secret',
      })
    ).response.status,
    400,
  )
  assert.equal((await call('/api/info', ServerInfo)).name, 'Integration studio')
  const seat = (await call('/api/snapshot', Snapshot, owner.token)).server
  assert.equal(seat.role, 'admin')
  assert.equal(seat.memberCount, 1)
  pass('onboarding needs the setup code, makes the admin, names the server, and cannot run twice')

  const code = await friendCode(ownerClient)
  const memberClient = new Client(origin)
  const memberUser = await joinFriend(
    memberClient,
    code,
    'colleague',
    'colleague-secret',
    'Integration colleague',
  )
  const member = account(memberClient, memberUser)
  const joined = await call('/api/snapshot', Snapshot, member.token)
  assert.equal(joined.server.role, 'member')
  assert.equal(joined.server.memberCount, 2)
  const memberInvite = await request('/api/friend-invite', { token: member.token })
  assert.equal(memberInvite.response.status, 403)
  assert.deepEqual(memberInvite.data, { message: 'Only an admin can do that.' })
  const memberReset = await request('/api/members/password', {
    token: member.token,
    body: { userId: owner.user.id, password: 'replaced-secret' },
  })
  assert.equal(memberReset.response.status, 403)
  assert.deepEqual(memberReset.data, { message: 'Only an admin can do that.' })
  const badJoin = await new Client(origin).call('/api/access', {
    kind: 'account.join',
    code: 'not-a-real-join-code-xx',
    username: 'outsider',
    password: 'outsider-secret',
  })
  assert.equal(badJoin.response.status, 400)
  assert.deepEqual(AccessError.parse(badJoin.value), { error: 'invalid' })
  const lateClient = new Client(origin)
  const lateUser = await joinFriend(
    lateClient,
    code,
    'latefriend',
    'late-secret-1',
    'Late colleague',
  )
  assert.equal((await call('/api/snapshot', Snapshot, owner.token)).server.memberCount, 3)
  const lateCutOff = await watchedSession(lateClient.sessionToken())
  const lateLaptop = new Client(origin)
  await lateLaptop.act({
    kind: 'account.signin',
    username: 'latefriend',
    password: 'late-secret-1',
  })
  const reset = await request('/api/members/password', {
    token: owner.token,
    body: { userId: lateUser.id, password: 'late-secret-2' },
  })
  assert.equal(reset.response.status, 200, JSON.stringify(reset.data))
  assert.deepEqual(reset.data, {})
  await lateCutOff('an admin reset signs the friend out')
  assert.equal((await lateLaptop.call('/api/snapshot')).response.status, 401)
  const stale = await new Client(origin).call('/api/access', {
    kind: 'account.signin',
    username: 'latefriend',
    password: 'late-secret-1',
  })
  assert.equal(stale.response.status, 400)
  assert.deepEqual(AccessError.parse(stale.value), { error: 'invalid' })
  const returned = await new Client(origin).act({
    kind: 'account.signin',
    username: 'latefriend',
    password: 'late-secret-2',
  })
  assert.equal(returned.stage.kind, 'ready')
  pass(
    'friends join with the invite code, a bad code fails, and an admin reset cuts off HTTP, the watch and its tickets for every session',
  )

  const mascot = { kind: 'mascot', shape: 'circle', color: 'indigo' }
  const roster = (await call('/api/members', Members, member.token)).members
  assert.deepEqual(
    roster.map(({ name, avatar, role }) => ({ name, avatar, role })),
    [
      { name: 'Integration owner', avatar: mascot, role: 'admin' },
      { name: 'Integration colleague', avatar: mascot, role: 'member' },
      { name: 'Late colleague', avatar: mascot, role: 'member' },
    ],
  )
  assert.equal(roster[0]?.id, owner.user.id)
  assert.ok(roster.every((person) => Date.parse(person.joinedAt) <= Date.now()))
  assert.deepEqual(await call('/api/members', Members, owner.token), { members: roster })
  pass('every member sees the roster: admins first, with avatar and role')

  const resetClient = new Client(origin)
  await joinFriend(resetClient, code, 'resetfriend', 'forgotten-secret', 'Reset friend')
  const cliCutOff = await watchedSession(resetClient.sessionToken())
  const resetLaptop = new Client(origin)
  await resetLaptop.act({
    kind: 'account.signin',
    username: 'resetfriend',
    password: 'forgotten-secret',
  })
  const resetByCli = await accountReset('resetfriend', 'operator-chosen-secret')
  assert.equal(resetByCli.code, 0, resetByCli.stderr)
  assert.match(resetByCli.stdout, /Reset the password for resetfriend/)
  assert.ok(
    resetByCli.args.every((arg) => !arg.includes('operator-chosen-secret')),
    'the new password never appears in argv',
  )
  await cliCutOff('the CLI signs out every session of the account')
  assert.equal((await resetLaptop.call('/api/snapshot')).response.status, 401)
  const forgotten = await new Client(origin).call('/api/access', {
    kind: 'account.signin',
    username: 'resetfriend',
    password: 'forgotten-secret',
  })
  assert.equal(forgotten.response.status, 400)
  assert.deepEqual(AccessError.parse(forgotten.value), { error: 'invalid' })
  const operatorChosen = await new Client(origin).act({
    kind: 'account.signin',
    username: 'resetfriend',
    password: 'operator-chosen-secret',
  })
  assert.equal(operatorChosen.stage.kind, 'ready')
  const unknown = await accountReset('nobody-here', 'operator-chosen-secret')
  assert.notEqual(unknown.code, 0)
  assert.match(unknown.stderr, /No account has the username nobody-here\./)
  pass(
    'account:reset replaces the password from stdin, cuts off HTTP, the watch and its tickets for every session, and names an unknown user',
  )

  const studio = await call('/api/rooms', Room, owner.token, { name: 'Studio' })
  const channel = await call('/api/channels', Channel, owner.token, {
    roomId: studio.id,
    name: 'general',
    kind: 'text',
  })
  assert.equal(
    (
      await request('/api/channels', {
        token: member.token,
        body: { roomId: studio.id, name: 'forbidden', kind: 'text' },
      })
    ).response.status,
    403,
  )
  assert.equal(
    (await request('/api/rooms', { token: member.token, body: { name: 'Forbidden' } })).response
      .status,
    403,
  )
  pass('only admins create rooms and channels')
  const snapshot = await call('/api/snapshot', Snapshot, owner.token)
  const first = watch(owner.token, snapshot.cursor)
  const ticket = await call('/api/watch-ticket', z.object({ ticket: z.string() }), member.token, {})
  const second = watch('', snapshot.cursor, ticket.ticket)
  await eventually(() => first.ready && second.ready, 'Both clients are subscribed')
  await rejectedFrame({ kind: 'watch', after: snapshot.cursor, ticket: ticket.ticket })
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
    roomId: studio.id,
    name: 'design',
    kind: 'text',
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
  const fixture = new pg.Client({ connectionString: database.url })
  await fixture.connect()
  let silentMessage: Message
  try {
    await fixture.query('BEGIN')
    await fixture.query('SELECT singleton FROM server FOR UPDATE')
    const row = await fixture.query<Record<string, unknown>>(
      'UPDATE server SET cursor = cursor + 1 RETURNING cursor::text',
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
    await fixture.query('INSERT INTO event(cursor, event) VALUES ($1,$2)', [
      cursor,
      { kind: 'message.created', message: silentMessage, cursor },
    ])
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
  const storedWithoutMentions = first.events.find(
    (event) => event.kind === 'message.created' && event.message.id === silentMessage.id,
  )
  assert.equal(storedWithoutMentions?.kind, 'message.created')
  assert.deepEqual(
    storedWithoutMentions?.kind === 'message.created' && storedWithoutMentions.mentions,
    [],
    'a stored message.created event without mentions still parses',
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
    roomId: studio.id,
    name: 'replay',
    kind: 'text',
  })
  const reconnected = watch(member.token, cursor)
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
  const beforeOverlap = await call('/api/snapshot', Snapshot, owner.token)
  const overlap = await call('/api/messages', Message, owner.token, {
    channelId: channel.id,
    retryId: randomUUID(),
    body: 'Between snapshot and watch.',
  })
  const racing = watch(owner.token, beforeOverlap.cursor)
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
  await rejectedFrame({ kind: 'watch', after: '0', token: 'invalid-session' })
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
    (await request('/api/snapshot', { token: owner.token, requestOrigin: 'tauri://localhost' }))
      .response.status,
    200,
  )
  assert.equal(
    (
      await request('/api/snapshot', {
        token: owner.token,
        requestOrigin: 'http://tauri.localhost',
      })
    ).response.status,
    200,
  )
  pass('malformed frames, invalid sessions, unauthorized watches, and untrusted origins reject')
  const snapshotOf = (token: string) => call('/api/snapshot', Snapshot, token)
  const beforeRooms = await snapshotOf(owner.token)
  assert.deepEqual(beforeRooms.rooms, [studio])
  assert.equal(
    (
      await request('/api/rooms', {
        token: member.token,
        body: { name: 'Lounge' },
      })
    ).response.status,
    403,
  )
  const lounge = await call('/api/rooms', Room, owner.token, { name: ' Lounge ' })
  assert.deepEqual(lounge, { id: lounge.id, name: 'Lounge' })
  assert.equal(
    (
      await request('/api/rooms', {
        token: owner.token,
        body: { name: 'LOUNGE' },
      })
    ).response.status,
    409,
  )
  assert.equal(
    (
      await request('/api/rooms', {
        token: owner.token,
        body: { name: 'Extra field', roomId: studio.id },
      })
    ).response.status,
    400,
  )
  const lobby = await call('/api/channels', Channel, owner.token, {
    roomId: lounge.id,
    name: 'general',
    kind: 'text',
  })
  assert.deepEqual(lobby, { id: lobby.id, roomId: lounge.id, name: 'general', kind: 'text' })
  assert.notEqual(lobby.id, channel.id)
  assert.equal(
    (
      await request('/api/channels', {
        token: owner.token,
        body: { roomId: lounge.id, name: 'General', kind: 'text' },
      })
    ).response.status,
    409,
  )
  assert.equal(
    (
      await request('/api/channels', {
        token: owner.token,
        body: { roomId: randomUUID(), name: 'nowhere', kind: 'text' },
      })
    ).response.status,
    404,
  )
  const afterRooms = await snapshotOf(owner.token)
  assert.deepEqual(afterRooms.rooms, [lounge, studio])
  assert.deepEqual(
    afterRooms.channels
      .filter((item) => item.name === 'general')
      .map((item) => item.roomId)
      .sort(),
    [lounge.id, studio.id].sort(),
  )
  await eventually(
    () =>
      first.events.some((event) => event.kind === 'room.created' && event.room.id === lounge.id),
    'room.created is delivered to a live watch',
  )
  const roomReplay = watch(member.token, beforeRooms.cursor)
  await eventually(() => roomReplay.events.length >= 2, 'Room events replay')
  assert.deepEqual(roomReplay.events.slice(0, 2), [
    { kind: 'room.created', cursor: String(BigInt(beforeRooms.cursor) + 1n), room: lounge },
    { kind: 'channel.created', cursor: String(BigInt(beforeRooms.cursor) + 2n), channel: lobby },
  ])
  pass('admins create rooms with unique names; channel names are unique per room; rooms replay')

  const beforeVoice = await snapshotOf(owner.token)
  assert.equal(
    (
      await request('/api/channels', {
        token: owner.token,
        body: { roomId: lounge.id, name: 'nokind' },
      })
    ).response.status,
    400,
    'a channel must state its kind',
  )
  assert.equal(
    (
      await request('/api/channels', {
        token: owner.token,
        body: { roomId: lounge.id, name: 'video', kind: 'video' },
      })
    ).response.status,
    400,
    'a channel kind is text or voice',
  )
  assert.equal(
    (
      await request('/api/channels', {
        token: owner.token,
        body: { roomId: lounge.id, name: 'general', kind: 'voice' },
      })
    ).response.status,
    409,
    'text and voice channels share one namespace in a room',
  )
  const hangout = await call('/api/channels', Channel, owner.token, {
    roomId: lounge.id,
    name: 'hangout',
    kind: 'voice',
  })
  assert.deepEqual(hangout, { id: hangout.id, roomId: lounge.id, name: 'hangout', kind: 'voice' })
  const voiceReplay = watch(member.token, beforeVoice.cursor)
  await eventually(() => voiceReplay.events.length >= 1, 'The voice channel replays')
  assert.deepEqual(voiceReplay.events, [
    {
      kind: 'channel.created',
      cursor: String(BigInt(beforeVoice.cursor) + 1n),
      channel: hangout,
    },
  ])
  const voicePost = await request('/api/messages', {
    token: member.token,
    body: { channelId: hangout.id, retryId: randomUUID(), body: 'Anyone here?' },
  })
  assert.equal(voicePost.response.status, 409)
  assert.deepEqual(voicePost.data, { message: 'Voice channels do not hold messages.' })
  assert.deepEqual(
    await call(`/api/messages?channelId=${hangout.id}`, Message.array(), owner.token),
    [],
    'a rejected voice post leaves no message',
  )
  const afterVoice = await snapshotOf(owner.token)
  assert.equal(
    afterVoice.cursor,
    voiceReplay.events[0]?.cursor,
    'a rejected voice post advances no cursor',
  )
  assert.deepEqual(
    afterVoice.channels.find((item) => item.id === hangout.id),
    hangout,
  )
  pass(
    'voice channels list and replay with their kind, share the room namespace, and reject messages',
  )

  const sent: Message[] = []
  for (const body of ['First unread', 'Second unread', '@integration OWNER, can you look?'])
    sent.push(
      await call('/api/messages', Message, member.token, {
        channelId: lobby.id,
        retryId: randomUUID(),
        body,
      }),
    )
  const [firstUnread, , mention] = sent
  assert(firstUnread && mention)
  assert.deepEqual((await snapshotOf(owner.token)).unread, [
    { channelId: lobby.id, count: 3, mentions: 1 },
  ])
  assert.equal(
    (await snapshotOf(member.token)).unread.some((item) => item.channelId === lobby.id),
    false,
  )
  await eventually(
    () =>
      first.events.some(
        (event) => event.kind === 'message.created' && event.message.id === mention.id,
      ),
    'the mention reaches a live watch',
  )
  const mentionsOf = (id: string) =>
    first.events.flatMap((event) =>
      event.kind === 'message.created' && event.message.id === id ? event.mentions : [],
    )
  assert.deepEqual(mentionsOf(mention.id), [owner.user.id])
  assert.deepEqual(mentionsOf(firstUnread.id), [])
  pass(
    'unread counts skip your own messages, the snapshot counts unread mentions, and the event names who was mentioned',
  )

  const markRead = (token: string, body: unknown) => request('/api/read', { token, body })
  const cleared = await markRead(owner.token, { channelId: lobby.id, cursor: firstUnread.cursor })
  assert.equal(cleared.response.status, 200)
  assert.deepEqual(cleared.data, {})
  assert.deepEqual((await snapshotOf(owner.token)).unread, [
    { channelId: lobby.id, count: 2, mentions: 1 },
  ])
  assert.equal(
    (await markRead(owner.token, { channelId: lobby.id, cursor: mention.cursor })).response.status,
    200,
  )
  assert.deepEqual((await snapshotOf(owner.token)).unread, [])
  assert.equal(
    (await markRead(owner.token, { channelId: lobby.id, cursor: firstUnread.cursor })).response
      .status,
    200,
  )
  assert.deepEqual((await snapshotOf(owner.token)).unread, [])
  for (const cursor of ['9000000000000000000', '9999999999999999999'])
    assert.equal(
      (await markRead(owner.token, { channelId: lobby.id, cursor })).response.status,
      200,
    )
  await call('/api/messages', Message, member.token, {
    channelId: lobby.id,
    retryId: randomUUID(),
    body: 'Fourth unread',
  })
  assert.deepEqual((await snapshotOf(owner.token)).unread, [
    { channelId: lobby.id, count: 1, mentions: 0 },
  ])
  const memberBefore = await snapshotOf(member.token)
  assert.deepEqual(memberBefore.unread, [{ channelId: channel.id, count: 16, mentions: 0 }])
  assert.equal(
    (await markRead(member.token, { channelId: channel.id, cursor: memberBefore.cursor })).response
      .status,
    200,
  )
  assert.deepEqual((await snapshotOf(member.token)).unread, [])
  pass('read markers clear unread and mentions, never regress, and stop at the server cursor')

  assert.equal(
    (await markRead(owner.token, { channelId: randomUUID(), cursor: '1' })).response.status,
    404,
  )
  assert.equal(
    (await markRead(owner.token, { kind: 'all', cursor: '1' })).response.status,
    400,
    'the all-channels read marker is gone',
  )
  assert.equal(
    (await request('/api/home', { token: owner.token })).response.status,
    404,
    'the home feed endpoint is gone',
  )
  pass('read markers reject unknown channels and the removed feed endpoints are gone')

  const thirdClient = new Client(origin)
  const thirdUser = await joinFriend(
    thirdClient,
    code,
    'thirdparty',
    'third-secret-1',
    'Third party',
  )
  const third = account(thirdClient, thirdUser)
  const secret = `direct-secret-${randomUUID()}`
  const open = (token: string, userId: string) =>
    call('/api/direct/conversations', DirectConversation, token, { userId })
  const beforeDirect = await snapshotOf(owner.token)
  const conversation = await open(owner.token, member.user.id)
  assert.deepEqual(conversation, {
    id: conversation.id,
    peerId: member.user.id,
    latest: null,
    unread: 0,
  })
  assert.equal((await open(owner.token, member.user.id)).id, conversation.id)
  const fromPeer = await open(member.token, owner.user.id)
  assert.equal(fromPeer.id, conversation.id, 'find-or-create finds one row from either direction')
  assert.equal(fromPeer.peerId, owner.user.id)
  const afterOpen = await snapshotOf(owner.token)
  assert.equal(afterOpen.cursor, beforeDirect.cursor, 'opening a conversation emits no event')
  assert.deepEqual(afterOpen.directs, [])
  assert.deepEqual(
    (await snapshotOf(member.token)).directs,
    [],
    'an empty conversation does not appear for the peer',
  )
  const toSelf = await request('/api/direct/conversations', {
    token: owner.token,
    body: { userId: owner.user.id },
  })
  assert.equal(toSelf.response.status, 400)
  assert.deepEqual(toSelf.data, { message: 'You cannot message yourself.' })
  assert.equal(
    (
      await request('/api/direct/conversations', {
        token: owner.token,
        body: { userId: 'nobody-here' },
      })
    ).response.status,
    404,
  )
  assert.equal(
    (
      await request('/api/direct/conversations', {
        token: owner.token,
        body: { userId: member.user.id, extra: true },
      })
    ).response.status,
    400,
    'direct inputs are strict',
  )
  pass('find-or-create is idempotent both ways, silent, and rejects self and non-members')

  const bystander = watch(third.token, afterOpen.cursor)
  const ownerLive = watch(owner.token, afterOpen.cursor)
  const memberLive = watch(member.token, afterOpen.cursor)
  await eventually(
    () => bystander.ready && ownerLive.ready && memberLive.ready,
    'all three members watch',
  )
  const directInput = {
    conversationId: conversation.id,
    retryId: randomUUID(),
    body: `${secret} from the owner`,
  }
  const [dm, dmDuplicate] = await Promise.all([
    call('/api/direct/messages', DirectMessage, owner.token, directInput),
    call('/api/direct/messages', DirectMessage, owner.token, directInput),
  ])
  assert.deepEqual(dm, dmDuplicate, 'an exact retry returns the stored message')
  assert.equal(dm.conversationId, conversation.id)
  assert.equal(dm.authorId, owner.user.id)
  const reply = await call('/api/direct/messages', DirectMessage, member.token, {
    conversationId: conversation.id,
    retryId: randomUUID(),
    body: `${secret} from the member`,
  })
  const sawDirect = (events: ServerEvent[], id: string) =>
    events.some((event) => event.kind === 'direct.message.created' && event.message.id === id)
  await eventually(
    () =>
      sawDirect(ownerLive.events, dm.id) &&
      sawDirect(ownerLive.events, reply.id) &&
      sawDirect(memberLive.events, dm.id) &&
      sawDirect(memberLive.events, reply.id),
    'both participants receive both messages live',
  )
  const delivered = memberLive.events.find(
    (event) => event.kind === 'direct.message.created' && event.message.id === dm.id,
  )
  assert.deepEqual(
    delivered?.kind === 'direct.message.created' && [...delivered.participants].sort(),
    [owner.user.id, member.user.id].sort(),
    'the event alone tells a recipient who is in the conversation',
  )
  const ownerDirects = (await snapshotOf(owner.token)).directs
  assert.deepEqual(ownerDirects, [
    { id: conversation.id, peerId: member.user.id, latest: reply, unread: 1 },
  ])
  const memberDirects = (await snapshotOf(member.token)).directs
  assert.deepEqual(memberDirects, [
    { id: conversation.id, peerId: owner.user.id, latest: reply, unread: 1 },
  ])
  const directPath = `/api/direct/messages?conversationId=${conversation.id}`
  assert.deepEqual(await call(directPath, DirectMessage.array(), member.token), [dm, reply])
  pass('participants exchange messages live, with retry deduplication and per-reader unread')

  const roomAfterDirect = await call('/api/messages', Message, member.token, {
    channelId: channel.id,
    retryId: randomUUID(),
    body: 'Room message that follows the private ones.',
  })
  await eventually(
    () =>
      bystander.events.some(
        (event) => event.kind === 'message.created' && event.message.id === roomAfterDirect.id,
      ),
    'the bystander watch is live and past the private cursors',
  )
  const privateToOthers = [secret, conversation.id, dm.id, reply.id]
  const leaks = (text: string) =>
    [...privateToOthers, 'direct.message.created'].filter((needle) => text.includes(needle))
  assert.deepEqual(
    bystander.events.filter((event) => event.kind === 'direct.message.created'),
    [],
  )
  assert.deepEqual(leaks(bystander.frames.join('\n')), [], 'nothing private on a live watch')
  const fromZero = watch(third.token, '0')
  await eventually(
    () =>
      fromZero.events.some(
        (event) => event.kind === 'message.created' && event.message.id === roomAfterDirect.id,
      ),
    'a replay from cursor 0 reaches the end of the log',
  )
  assert.deepEqual(leaks(fromZero.frames.join('\n')), [], 'nothing private in replay from 0')
  const participantReplay = watch(member.token, '0')
  await eventually(
    () => sawDirect(participantReplay.events, reply.id),
    'the same replay does carry the messages to a participant',
  )
  fromZero.socket.terminate()
  participantReplay.socket.terminate()

  const thirdSnapshot = await rawText('/api/snapshot', third.token)
  assert.equal(thirdSnapshot.status, 200)
  assert.deepEqual(leaks(thirdSnapshot.text), [], 'nothing private in the snapshot')
  assert.deepEqual(Snapshot.parse(JSON.parse(thirdSnapshot.text)).directs, [])
  const notFound = JSON.stringify({ message: 'Conversation not found.' })
  const probes = (id: string) => [
    rawText(`/api/direct/messages?conversationId=${id}`, third.token),
    rawText('/api/direct/messages', third.token, {
      conversationId: id,
      retryId: randomUUID(),
      body: 'Let me in',
    }),
    rawText('/api/direct/read', third.token, { conversationId: id, cursor: '1' }),
  ]
  for (const answer of await Promise.all([...probes(conversation.id), ...probes(randomUUID())])) {
    assert.equal(answer.status, 404)
    assert.equal(
      answer.text,
      notFound,
      'a stranger gets the same answer as for an ID that does not exist',
    )
  }
  assert.equal(
    (await rawText(`/api/messages?channelId=${conversation.id}`, third.token)).status,
    404,
    'a conversation ID is not a channel',
  )
  for (const path of ['/api/snapshot', '/api/members', `/api/messages?channelId=${channel.id}`])
    assert.deepEqual(
      leaks((await rawText(path, third.token)).text),
      [],
      `nothing private in ${path}`,
    )
  assert.deepEqual(
    (await snapshotOf(owner.token)).directs,
    ownerDirects,
    'the stranger changed nothing',
  )
  pass(
    'a third member finds nothing in snapshot, replay, or a live watch, and gets the same 404 as for a random ID',
  )

  const conflict = JSON.stringify({
    message: 'This retry ID was already used for a different message.',
  })
  const changedBody = await rawText('/api/direct/messages', owner.token, {
    ...directInput,
    body: 'Changed',
  })
  assert.equal(changedBody.status, 409)
  assert.equal(changedBody.text, conflict)
  const elsewhere = await open(owner.token, third.user.id)
  assert.notEqual(elsewhere.id, conversation.id)
  const otherConversation = await rawText('/api/direct/messages', owner.token, {
    ...directInput,
    conversationId: elsewhere.id,
  })
  assert.equal(otherConversation.status, 409)
  assert.equal(otherConversation.text, conflict, 'a conflict returns no body')
  assert.deepEqual(
    await call(
      `/api/direct/messages?conversationId=${elsewhere.id}`,
      DirectMessage.array(),
      owner.token,
    ),
    [],
  )
  assert.deepEqual(
    (await snapshotOf(third.token)).directs,
    [],
    'a failed retry leaves the peer with nothing to see',
  )
  assert.equal(
    (
      await request('/api/direct/messages', {
        token: owner.token,
        body: { ...directInput, retryId: randomUUID(), body: '   ' },
      })
    ).response.status,
    400,
  )
  assert.equal(
    (await request('/api/direct/messages?conversationId=not-a-uuid', { token: owner.token }))
      .response.status,
    400,
  )
  pass('a reused retry ID is a conflict that returns no body, and input is validated')

  const readDirect = (token: string, cursor: string) =>
    request('/api/direct/read', { token, body: { conversationId: conversation.id, cursor } })
  const unreadOf = async (token: string) =>
    (await snapshotOf(token)).directs.find((item) => item.id === conversation.id)?.unread
  const clearedDirect = await readDirect(member.token, dm.cursor)
  assert.equal(clearedDirect.response.status, 200)
  assert.deepEqual(clearedDirect.data, {})
  assert.equal(await unreadOf(member.token), 0, 'your own reply is never unread')
  assert.equal(await unreadOf(owner.token), 1, 'reading is private to each participant')
  assert.equal((await readDirect(owner.token, reply.cursor)).response.status, 200)
  assert.equal(await unreadOf(owner.token), 0)
  assert.equal((await readDirect(owner.token, dm.cursor)).response.status, 200)
  assert.equal(await unreadOf(owner.token), 0, 'a read marker never moves back')
  assert.equal((await readDirect(owner.token, '9999999999999999999')).response.status, 200)
  const afterCap = await call('/api/direct/messages', DirectMessage, member.token, {
    conversationId: conversation.id,
    retryId: randomUUID(),
    body: 'After the capped read marker',
  })
  assert.equal(await unreadOf(owner.token), 1, 'a read marker stops at the server cursor')
  pass('direct read markers clear unread per reader, never regress, and stop at the server cursor')

  const paged = await open(third.token, member.user.id)
  const sentPages: DirectMessage[] = []
  for (let index = 0; index < 101; index++)
    sentPages.push(
      await call('/api/direct/messages', DirectMessage, third.token, {
        conversationId: paged.id,
        retryId: randomUUID(),
        body: `Page line ${index}`,
      }),
    )
  const pagedPath = `/api/direct/messages?conversationId=${paged.id}`
  const newestPage = await call(pagedPath, DirectMessage.array(), member.token)
  assert.deepEqual(newestPage, sentPages.slice(1))
  assert.deepEqual(
    await call(`${pagedPath}&before=${newestPage[0]?.cursor}`, DirectMessage.array(), member.token),
    sentPages.slice(0, 1),
  )
  assert.deepEqual(
    await call(`${pagedPath}&before=9999999999999999999`, DirectMessage.array(), member.token),
    sentPages.slice(1),
  )
  assert.deepEqual(
    (await snapshotOf(member.token)).directs.map((item) => item.id),
    [paged.id, conversation.id],
    'the snapshot lists the most recent conversation first',
  )
  pass('direct history pages 100 at a time, oldest first, and takes any valid before cursor')

  const photoStatus = async (id: string, token: string) =>
    (
      await fetch(`${origin}/api/account/photo/${id}`, {
        headers: { Origin: origin, Authorization: `Bearer ${token}` },
      })
    ).status
  const uploadPhoto = async (background: { r: number; g: number; b: number }) => {
    const png = await sharp({ create: { width: 16, height: 16, channels: 3, background } })
      .png()
      .toBuffer()
    const form = new FormData()
    form.set('photo', new File([new Uint8Array(png)], 'a.png', { type: 'image/png' }))
    const uploaded = await fetch(`${origin}/api/account/photo`, {
      method: 'POST',
      headers: { Origin: origin, Authorization: `Bearer ${third.token}` },
      body: form,
    })
    assert.equal(uploaded.status, 200)
    return z.object({ uploadId: z.uuid() }).parse(await uploaded.json()).uploadId
  }
  const privatePhoto = await uploadPhoto({ r: 200, g: 40, b: 40 })
  const unusedPhoto = await uploadPhoto({ r: 40, g: 40, b: 200 })
  const saveAvatar = (avatar: Avatar) =>
    thirdClient.act({ kind: 'profile.save', profile: { name: 'Third party', avatar } })
  await saveAvatar({ kind: 'photo', uploadId: privatePhoto })
  assert.equal(await photoStatus(privatePhoto, member.token), 200, 'a current avatar is visible')
  const withOwner = await open(third.token, owner.user.id)
  const withPhoto = await call('/api/direct/messages', DirectMessage, third.token, {
    conversationId: withOwner.id,
    retryId: randomUUID(),
    body: 'Sent with a photo avatar.',
  })
  assert.deepEqual(withPhoto.authorAvatar, { kind: 'photo', uploadId: privatePhoto })
  await saveAvatar({ kind: 'mascot', shape: 'circle', color: 'teal' })
  assert.equal(await photoStatus(privatePhoto, owner.token), 200, 'the peer still sees it')
  assert.equal(await photoStatus(privatePhoto, third.token), 200, 'the author still sees it')
  assert.equal(
    await photoStatus(privatePhoto, member.token),
    await photoStatus(unusedPhoto, member.token),
    'a photo only a direct message uses looks like any unreachable photo to a third member',
  )
  assert.equal(await photoStatus(privatePhoto, member.token), 400)
  for (const path of ['/api/snapshot', directPath])
    assert.equal(
      (await request(path, { token: owner.token })).response.headers.get('cache-control'),
      'no-store',
    )
  pass(
    'a photo used only in a direct message reveals nothing to a third member, and data responses are not cacheable',
  )

  const removedClient = new Client(origin)
  await removedClient.act({
    kind: 'account.signin',
    username: 'latefriend',
    password: 'late-secret-2',
  })
  const scratch = new pg.Client({ connectionString: database.url })
  await scratch.connect()
  try {
    await scratch.query('DELETE FROM member WHERE user_id = $1', [lateUser.id])
  } finally {
    await scratch.end()
  }
  const formerToken = removedClient.sessionToken()
  const notMember = { message: 'You are not a member of this server. Ask an admin for an invite.' }
  for (const answer of await Promise.all([
    request(directPath, { token: formerToken }),
    request('/api/direct/conversations', {
      token: formerToken,
      body: { userId: owner.user.id },
    }),
    request('/api/direct/messages', {
      token: formerToken,
      body: { conversationId: conversation.id, retryId: randomUUID(), body: 'Hello?' },
    }),
    request('/api/direct/read', {
      token: formerToken,
      body: { conversationId: conversation.id, cursor: '1' },
    }),
  ])) {
    assert.equal(answer.response.status, 403)
    assert.deepEqual(answer.data, notMember)
  }
  assert.equal(
    (
      await request('/api/direct/conversations', {
        token: owner.token,
        body: { userId: lateUser.id },
      })
    ).response.status,
    404,
    'an account that is not a member cannot be messaged',
  )
  pass('every direct operation requires membership, and non-member targets are rejected')

  await call('/api/auth/sign-out', z.unknown(), member.token, {})
  await eventually(
    () => reconnected.socket.readyState === WebSocket.CLOSED,
    'A revoked session cannot keep watching',
  )
  assert.equal((await request('/api/snapshot', { token: member.token })).response.status, 401)
  pass('session revocation closes an existing watch and denies subsequent HTTP reads')
  for (const socket of sockets) socket.terminate()
  await server.stop()
  await server.start()
  const persisted = await call(
    `/api/messages?channelId=${channel.id}`,
    Message.array(),
    owner.token,
  )
  assert.ok(persisted.some((item) => item.id === offline.id))
  assert.deepEqual(await call(directPath, DirectMessage.array(), owner.token), [
    dm,
    reply,
    afterCap,
  ])
  const thirdAfterRestart = watch(third.token, '0')
  await eventually(
    () =>
      thirdAfterRestart.events.some(
        (event) => event.kind === 'message.created' && event.message.id === roomAfterDirect.id,
      ),
    'replay after a restart reaches the room message',
  )
  const replayedText = thirdAfterRestart.frames.join('\n')
  assert.deepEqual(
    privateToOthers.filter((needle) => replayedText.includes(needle)),
    [],
    'still nothing from a conversation the caller is not in',
  )
  assert.ok(
    thirdAfterRestart.events.some(
      (event) =>
        event.kind === 'direct.message.created' && event.message.conversationId === paged.id,
    ),
    'the caller still replays its own conversation',
  )
  const restarted = watch(owner.token, cursor)
  await eventually(
    () =>
      restarted.events.some(
        (event) => event.kind === 'message.created' && event.message.id === offline.id,
      ),
    'Events survive a server restart',
  )
  pass('messages, direct messages, sessions, and filtered replay survive an actual server restart')
} catch (error) {
  process.stderr.write(server.logs())
  throw error
} finally {
  for (const socket of sockets) socket.terminate()
  await server.stop()
  await database.drop()
}
