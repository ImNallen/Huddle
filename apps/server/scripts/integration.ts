import assert from 'node:assert/strict'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { WebSocket } from 'ws'
import pg from 'pg'
import {
  AccessError,
  Channel,
  DeviceCode,
  DeviceToken,
  EventPage,
  Home,
  Invitation,
  Members,
  Message,
  PendingInvitations,
  Room,
  ServerInfo,
  Session,
  Snapshot,
  UserId,
  type ServerEvent,
} from '@huddle/contracts'
import { mentionedUsers } from '../src/lib/domain'
import {
  Client,
  invite,
  invited,
  join,
  mailIds,
  migratedDatabase,
  nextMail,
  onboard,
  startServer,
  syntheticEmail,
} from './harness'

const setupCode = `integration-${randomUUID()}`
const database = await migratedDatabase()
const server = await startServer({
  databaseUrl: database.url,
  port: Number(process.env.TEST_PORT ?? 3100),
  env: { SETUP_CODE: setupCode },
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
function account(client: Client, identity: Awaited<ReturnType<typeof join>>) {
  return { token: client.sessionToken(), cookie: client.cookie(), user: identity.user }
}

function watch(token: string, after: string, ticket?: string) {
  const socket = new WebSocket(wsURL, { origin })
  sockets.add(socket)
  const events: ServerEvent[] = []
  let ready = false
  socket.on('open', () =>
    socket.send(JSON.stringify({ kind: 'watch', after, ...(ticket ? { ticket } : { token }) })),
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
  assert.equal((await request('/api/snapshot')).response.status, 401)
  assert.equal((await request('/api/rooms', { body: { name: 'anonymous' } })).response.status, 401)
  pass('anonymous requests cannot read the server or create rooms')

  const fresh = await call('/api/info', ServerInfo)
  assert.equal(fresh.setup, 'required')
  assert.equal(fresh.name, 'Huddle')
  const anonymous = new Client(origin)
  assert.equal((await anonymous.act({ kind: 'signout' })).stage.kind, 'setup')
  const adminEmail = syntheticEmail('admin')
  const wrong = await anonymous.call('/api/access', {
    kind: 'setup.start',
    code: 'not-the-setup-code',
    serverName: 'Integration studio',
    email: adminEmail,
  })
  assert.equal(wrong.response.status, 400)
  assert.deepEqual(AccessError.parse(wrong.value), { error: 'invalid' })
  assert.equal((await mailIds(adminEmail)).size, 0, 'a wrong setup code sends no email')
  const ownerClient = new Client(origin)
  const ownerIdentity = await onboard(ownerClient, {
    code: setupCode,
    serverName: 'Integration studio',
    email: adminEmail,
    name: 'Integration owner',
  })
  const owner = account(ownerClient, ownerIdentity)
  const named = await call('/api/info', ServerInfo)
  assert.equal(named.setup, 'complete')
  assert.equal(named.name, 'Integration studio')
  assert.equal((await new Client(origin).act({ kind: 'signout' })).stage.kind, 'signin')
  for (const code of [setupCode, 'a-brand-new-setup-code'])
    assert.equal(
      (
        await new Client(origin).call('/api/access', {
          kind: 'setup.start',
          code,
          serverName: 'Hijacked',
          email: syntheticEmail('intruder'),
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
        kind: 'setup.start',
        code: setupCode,
        serverName: 'Hijacked',
        email: syntheticEmail('intruder'),
      })
    ).response.status,
    400,
  )
  assert.equal((await call('/api/info', ServerInfo)).name, 'Integration studio')
  const seat = (await call('/api/snapshot', Snapshot, owner.token)).server
  assert.equal(seat.role, 'admin')
  assert.equal(seat.memberCount, 1)
  pass('onboarding needs the setup code, makes the admin, names the server, and cannot run twice')

  const strangerEmail = syntheticEmail('stranger')
  const stranger = new Client(origin)
  const strangerSeen = await mailIds(strangerEmail)
  const challenged = await stranger.act({ kind: 'email.send', email: strangerEmail })
  assert.equal(challenged.stage.kind, 'email')
  const refusal = await nextMail(strangerEmail, strangerSeen)
  assert.match(refusal.text, /sign in to Integration studio with this email address/)
  assert.match(refusal.text, /there is no account for it/)
  assert.match(refusal.text, /ask an admin to invite you/)
  assert.doesNotMatch(refusal.text, /\b\d{6}\b/)
  const guessed = await stranger.call('/api/access', { kind: 'email.verify', code: '123456' })
  assert.equal(guessed.response.status, 400)
  const fixtureDb = new pg.Client({ connectionString: database.url })
  fixtureDb.on('error', () => undefined)
  await fixtureDb.connect()
  const users = async (email: string) =>
    (await fixtureDb.query('SELECT 1 FROM "user" WHERE email = $1', [email])).rowCount
  assert.equal(await users(strangerEmail), 0)
  pass(
    'an uninvited address sees the same email step, gets a no-account email, and gets no account',
  )

  const memberClient = new Client(origin)
  const memberIdentity = await invited(ownerClient, memberClient, 'Integration colleague')
  const member = account(memberClient, memberIdentity)
  const joined = await call('/api/snapshot', Snapshot, member.token)
  assert.equal(joined.server.role, 'member')
  assert.equal(joined.server.memberCount, 2)
  const memberInvite = await request('/api/invitations', {
    token: member.token,
    body: { email: syntheticEmail('friend') },
  })
  assert.equal(memberInvite.response.status, 403)
  const again = await request('/api/invitations', {
    token: owner.token,
    body: { email: memberIdentity.email },
  })
  assert.equal(again.response.status, 409)
  const lateEmail = syntheticEmail('late')
  const firstInvite = Invitation.parse(await invite(ownerClient, lateEmail))
  await fixtureDb.query(
    "UPDATE invitation SET expires_at = now() - interval '1 minute' WHERE email = $1",
    [lateEmail],
  )
  const lateSeen = await mailIds(lateEmail)
  await new Client(origin).act({ kind: 'email.send', email: lateEmail })
  assert.match((await nextMail(lateEmail, lateSeen)).text, /there is no account for it/)
  const refreshed = Invitation.parse(await invite(ownerClient, lateEmail))
  assert.ok(Date.parse(refreshed.expiresAt) > Date.now() + 6 * 86400000)
  assert.ok(Date.parse(refreshed.expiresAt) >= Date.parse(firstInvite.expiresAt))
  const invitationMail = await nextMail(lateEmail, lateSeen)
  assert.equal(
    invitationMail.subject,
    'Integration owner invited you to Integration studio on Huddle',
  )
  assert.ok(invitationMail.text.includes(`Accept invitation: ${origin}/login`))
  assert.ok(invitationMail.text.includes(`Then sign in with ${lateEmail}.`))
  await join(new Client(origin), lateEmail, 'Late colleague')
  const accepted = await fixtureDb.query('SELECT accepted_by FROM invitation WHERE email = $1', [
    lateEmail,
  ])
  assert.ok(accepted.rows[0].accepted_by)
  assert.equal((await call('/api/snapshot', Snapshot, owner.token)).server.memberCount, 3)
  pass(
    'admins invite by email; expired invites stop working, re-inviting refreshes, members cannot invite',
  )

  const mascot = { kind: 'mascot', shape: 'circle', color: 'indigo' }
  const roster = (await call('/api/members', Members, member.token)).members
  assert.deepEqual(
    roster.map(({ name, email, avatar, role, invitedBy }) => ({
      name,
      email,
      avatar,
      role,
      invitedBy,
    })),
    [
      {
        name: 'Integration owner',
        email: adminEmail,
        avatar: mascot,
        role: 'admin',
        invitedBy: null,
      },
      {
        name: 'Integration colleague',
        email: memberIdentity.email,
        avatar: mascot,
        role: 'member',
        invitedBy: 'Integration owner',
      },
      {
        name: 'Late colleague',
        email: lateEmail,
        avatar: mascot,
        role: 'member',
        invitedBy: 'Integration owner',
      },
    ],
  )
  assert.equal(roster[0]?.id, owner.user.id)
  assert.ok(roster.every((person) => Date.parse(person.joinedAt) <= Date.now()))
  assert.deepEqual(await call('/api/members', Members, owner.token), { members: roster })
  pass('every member sees the roster: admins first, with avatar, role, and who invited them')

  assert.equal((await request('/api/invitations', { token: member.token })).response.status, 403)
  const pendingEmail = syntheticEmail('pending')
  const pendingInvite = Invitation.parse(await invite(ownerClient, pendingEmail))
  const lapsedEmail = syntheticEmail('lapsed')
  await invite(ownerClient, lapsedEmail)
  await fixtureDb.query(
    "UPDATE invitation SET expires_at = '2026-10-08T12:00:00Z' WHERE email = $1",
    [lapsedEmail],
  )
  assert.deepEqual(await call('/api/invitations', PendingInvitations, owner.token), {
    invitations: [
      { email: lapsedEmail, expiresAt: '2026-10-08T12:00:00.000Z', invitedBy: 'Integration owner' },
      { email: pendingEmail, expiresAt: pendingInvite.expiresAt, invitedBy: 'Integration owner' },
    ],
  })
  const memberRevoke = await request('/api/invitations/revoke', {
    token: member.token,
    body: { email: pendingEmail },
  })
  assert.equal(memberRevoke.response.status, 403)
  assert.deepEqual(memberRevoke.data, { message: 'Only an admin can do that.' })
  assert.deepEqual(
    await call('/api/invitations/revoke', z.unknown(), owner.token, {
      email: pendingEmail.toUpperCase(),
    }),
    {},
  )
  assert.deepEqual(await call('/api/invitations', PendingInvitations, owner.token), {
    invitations: [
      { email: lapsedEmail, expiresAt: '2026-10-08T12:00:00.000Z', invitedBy: 'Integration owner' },
    ],
  })
  const twice = await request('/api/invitations/revoke', {
    token: owner.token,
    body: { email: pendingEmail },
  })
  assert.equal(twice.response.status, 404)
  assert.deepEqual(twice.data, { message: `There is no pending invitation for ${pendingEmail}.` })
  const acceptedRevoke = await request('/api/invitations/revoke', {
    token: owner.token,
    body: { email: memberIdentity.email },
  })
  assert.equal(acceptedRevoke.response.status, 404)
  const revokedSeen = await mailIds(pendingEmail)
  await new Client(origin).act({ kind: 'email.send', email: pendingEmail })
  assert.match((await nextMail(pendingEmail, revokedSeen)).text, /there is no account for it/)
  assert.equal(await users(pendingEmail), 0)
  assert.equal((await call('/api/members', Members, owner.token)).members.length, 3)
  await fixtureDb.end()
  pass(
    'admins list pending invitations, expired ones included; revoking one stops that address from joining',
  )

  const studio = await call('/api/rooms', Room, owner.token, { name: 'Studio' })
  const channel = await call('/api/channels', Channel, owner.token, {
    roomId: studio.id,
    name: 'general',
  })
  assert.equal(
    (
      await request('/api/channels', {
        token: member.token,
        body: { roomId: studio.id, name: 'forbidden' },
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
  const homeOf = (token: string) => call('/api/home', Home, token)
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
  })
  assert.deepEqual(lobby, { id: lobby.id, roomId: lounge.id, name: 'general' })
  assert.notEqual(lobby.id, channel.id)
  assert.equal(
    (
      await request('/api/channels', {
        token: owner.token,
        body: { roomId: lounge.id, name: 'General' },
      })
    ).response.status,
    409,
  )
  assert.equal(
    (
      await request('/api/channels', {
        token: owner.token,
        body: { roomId: randomUUID(), name: 'nowhere' },
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
  assert.deepEqual((await snapshotOf(owner.token)).unread, [{ channelId: lobby.id, count: 3 }])
  assert.equal(
    (await snapshotOf(member.token)).unread.some((item) => item.channelId === lobby.id),
    false,
  )
  assert.deepEqual(await homeOf(owner.token), {
    items: [
      { kind: 'mention', message: mention },
      { kind: 'channel', channelId: lobby.id, count: 3, latest: mention },
    ],
  })
  const memberHome = await homeOf(member.token)
  assert.deepEqual(
    memberHome.items.filter((item) => item.kind === 'mention'),
    [],
  )
  assert.equal(
    memberHome.items.some((item) => item.kind === 'channel' && item.channelId === lobby.id),
    false,
  )
  pass('unread counts skip your own messages and an @Name mention reaches only that home')

  const markRead = (token: string, body: unknown) => request('/api/read', { token, body })
  const cleared = await markRead(owner.token, {
    kind: 'channel',
    channelId: lobby.id,
    cursor: mention.cursor,
  })
  assert.equal(cleared.response.status, 200)
  assert.deepEqual(cleared.data, {})
  assert.deepEqual((await snapshotOf(owner.token)).unread, [])
  assert.deepEqual(await homeOf(owner.token), { items: [] })
  assert.equal(
    (
      await markRead(owner.token, {
        kind: 'channel',
        channelId: lobby.id,
        cursor: firstUnread.cursor,
      })
    ).response.status,
    200,
  )
  assert.deepEqual((await snapshotOf(owner.token)).unread, [])
  assert.deepEqual(await homeOf(owner.token), { items: [] })
  for (const cursor of ['9000000000000000000', '9999999999999999999'])
    assert.equal(
      (await markRead(owner.token, { kind: 'channel', channelId: lobby.id, cursor })).response
        .status,
      200,
    )
  const late = await call('/api/messages', Message, member.token, {
    channelId: lobby.id,
    retryId: randomUUID(),
    body: 'Fourth unread',
  })
  assert.deepEqual((await snapshotOf(owner.token)).unread, [{ channelId: lobby.id, count: 1 }])
  assert.deepEqual(await homeOf(owner.token), {
    items: [{ kind: 'channel', channelId: lobby.id, count: 1, latest: late }],
  })
  const memberBefore = await snapshotOf(member.token)
  assert.deepEqual(memberBefore.unread, [{ channelId: channel.id, count: 16 }])
  const all = await markRead(member.token, { kind: 'all', cursor: memberBefore.cursor })
  assert.equal(all.response.status, 200)
  assert.deepEqual((await snapshotOf(member.token)).unread, [])
  assert.deepEqual(await homeOf(member.token), { items: [] })
  pass('read markers clear unread and home, never regress, and stop at the server cursor')

  assert.equal(
    (await markRead(owner.token, { kind: 'channel', channelId: randomUUID(), cursor: '1' }))
      .response.status,
    404,
  )
  pass('read markers reject unknown channels')
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
  const restarted = watch(owner.token, cursor)
  await eventually(
    () =>
      restarted.events.some(
        (event) => event.kind === 'message.created' && event.message.id === offline.id,
      ),
    'Events survive a server restart',
  )
  pass('messages, sessions, and durable replay survive an actual server restart')
} catch (error) {
  process.stderr.write(server.logs())
  throw error
} finally {
  for (const socket of sockets) socket.terminate()
  await server.stop()
  await database.drop()
}
