import assert from 'node:assert/strict'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { createHmac, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { WebSocket } from 'ws'
import pg from 'pg'
import sharp from 'sharp'
import {
  AccessError,
  AccessStage,
  type Avatar,
  Channel,
  defaultMascot,
  DirectConversation,
  DirectMessage,
  EventPage,
  Members,
  Message,
  Room,
  ServerInfo,
  Snapshot,
  UserId,
  VoiceGrant,
  type ServerEvent,
} from '@huddle/contracts'
import { mentionedUsers } from '../src/lib/domain'
import {
  accountLink,
  Client,
  inviteCode,
  joinFriend,
  migratedDatabase,
  runningLivekit,
  setupFriend,
  startServer,
  tailscale,
} from './harness'

const livekit = await runningLivekit()
const setupCode = `integration-${randomUUID()}`
const database = await migratedDatabase()
const port = Number(process.env.TEST_PORT ?? 3100)
const server = await startServer({
  databaseUrl: database.url,
  port,
  env: {
    SETUP_CODE: setupCode,
    LIVEKIT_API_SECRET: livekit.secret,
    LIVEKIT_PUBLIC_URL: livekit.url,
  },
}).catch(async (error: unknown) => {
  await database.drop()
  throw error
})
const origin = server.origin
const wsURL = server.websocket
const sockets = new Set<WebSocket>()
const accounts = new Map<string, string>()
function headersFor(login: string | undefined, requestOrigin: string, post: boolean) {
  const headers = new Headers({ 'Content-Type': 'application/json', Origin: requestOrigin })
  if (login) {
    for (const [name, value] of Object.entries(tailscale(login))) headers.set(name, value)
    const user = accounts.get(login)
    if (post && user) headers.set('X-Huddle-User', user)
  }
  return headers
}
async function request(
  path: string,
  {
    login,
    body,
    requestOrigin = origin,
  }: { login?: string; body?: unknown; requestOrigin?: string } = {},
) {
  const response = await fetch(origin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: headersFor(login, requestOrigin, body !== undefined),
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data: unknown = await response.json()
  return { response, data }
}
async function call<T>(path: string, schema: z.ZodType<T>, login?: string, body?: unknown) {
  const { response, data } = await request(path, { login, body })
  assert.equal(response.status, 200, `${path}: ${JSON.stringify(data)}`)
  return schema.parse(data)
}
async function rawText(path: string, login: string, body?: unknown) {
  const response = await fetch(origin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: headersFor(login, origin, body !== undefined),
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, text: await response.text() }
}
function account(client: Client, user: Awaited<ReturnType<typeof setupFriend>>) {
  const login = z.string().parse(client.login)
  accounts.set(login, user.id)
  return { login, user }
}

function watch(login: string, after: string) {
  const socket = new WebSocket(wsURL, { origin, headers: tailscale(login) })
  sockets.add(socket)
  const events: ServerEvent[] = []
  const frames: string[] = []
  let ready = false
  socket.on('open', () => socket.send(JSON.stringify({ kind: 'watch', after })))
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
    closed: once(socket, 'close').then(([code]) => z.number().parse(code)),
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
async function rejectedFrame(frame: unknown, login: string, expected = 1008) {
  const socket = new WebSocket(wsURL, { origin, headers: tailscale(login) })
  sockets.add(socket)
  socket.on('error', () => {})
  const closed = once(socket, 'close')
  await once(socket, 'open')
  socket.send(JSON.stringify(frame))
  const [code] = await closed
  sockets.delete(socket)
  assert.equal(code, expected)
}
async function refusedUpgrade(options: ConstructorParameters<typeof WebSocket>[2], url = wsURL) {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url, options)
    socket.on('unexpected-response', (_request, response) => {
      assert.equal(response.statusCode, 403)
      response.resume()
      socket.terminate()
      resolve()
    })
    socket.on('open', () => {
      socket.terminate()
      reject(new Error('The upgrade was accepted'))
    })
    socket.on('error', () => {})
  })
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
  const asked = async (headers: Record<string, string>) => {
    const answer = await fetch(`${origin}/api/access`, { headers })
    return AccessStage.parse(await answer.json())
  }
  assert.deepEqual(await asked({}), { kind: 'no-identity', reason: 'direct' })
  assert.deepEqual(await asked({ tailscale_user_login: 'evil@huddle.test' }), {
    kind: 'no-identity',
    reason: 'direct',
  })
  assert.deepEqual(
    await asked({
      'tailscale-user-login': 'ada@huddle.test',
      tailscale_user_login: 'evil@huddle.test',
    }),
    { kind: 'setup', login: 'ada@huddle.test', suggestedName: 'ada' },
    'the underscore header changes nothing beside the real one',
  )
  assert.deepEqual(
    await asked({ 'tailscale-user-login': 'ada@huddle.test', 'tailscale-funnel-request': '?1' }),
    { kind: 'no-identity', reason: 'funnel' },
  )
  assert.deepEqual(await asked({ 'x-forwarded-host': 'huddle.test' }), {
    kind: 'no-identity',
    reason: 'no-user',
  })
  const rebound = await new Promise<AccessStage>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () =>
      socket.write(
        'GET /api/access HTTP/1.1\r\nHost: evil.test\r\nTailscale-User-Login: ada@huddle.test\r\nConnection: close\r\n\r\n',
      ),
    )
    let text = ''
    socket.on('data', (chunk) => (text += chunk.toString()))
    socket.on('end', () => {
      try {
        resolve(AccessStage.parse(JSON.parse(text.slice(text.indexOf('{')))))
      } catch (error) {
        reject(error)
      }
    })
    socket.on('error', reject)
  })
  assert.deepEqual(
    rebound,
    { kind: 'no-identity', reason: 'direct' },
    'a rebound Host has no identity',
  )
  const unattested = await new Client(origin).call('/api/access', {
    kind: 'account.setup',
    code: setupCode,
    serverName: 'No identity',
    name: 'Nobody',
  })
  assert.equal(unattested.response.status, 401, 'no identity cannot set up, even with the code')
  assert.deepEqual(AccessError.parse(unattested.value), { error: 'no_access' })
  const external = Object.values(networkInterfaces())
    .flat()
    .filter((entry) => entry && !entry.internal && entry.family === 'IPv4')
    .map((entry) => z.string().parse(entry?.address))
  assert.ok(external.length > 0, 'this machine needs a non-loopback address to prove the bind')
  for (const listener of [port, port + 1])
    for (const address of external)
      await new Promise<void>((resolve, reject) => {
        const socket = connect(listener, address, () => {
          socket.destroy()
          reject(new Error(`${address}:${listener} accepted a connection`))
        })
        socket.on('error', () => resolve())
      })
  pass(
    'requests without Tailscale identity cannot read or set up, and no listener accepts off-host connections',
  )

  const fresh = await call('/api/info', ServerInfo)
  assert.equal(fresh.setup, 'required')
  assert.equal(fresh.name, 'Huddle')
  const visitor = new Client(origin, 'intruder@huddle.test')
  assert.equal((await visitor.stage()).kind, 'setup')
  const wrong = await visitor.call('/api/access', {
    kind: 'account.setup',
    code: 'not-the-setup-code',
    serverName: 'Integration studio',
    name: 'Intruder',
  })
  assert.equal(wrong.response.status, 400)
  assert.deepEqual(AccessError.parse(wrong.value), { error: 'invalid' })
  const ownerClient = new Client(origin, 'owner@huddle.test')
  const setupInput = {
    kind: 'account.setup',
    code: setupCode,
    serverName: 'Integration studio',
    name: 'Integration owner',
  } as const
  const ownerUser = await setupFriend(ownerClient, setupInput)
  const owner = account(ownerClient, ownerUser)
  const named = await call('/api/info', ServerInfo)
  assert.equal(named.setup, 'complete')
  assert.equal(named.name, 'Integration studio')
  assert.deepEqual(
    await ownerClient.act(setupInput),
    await ownerClient.stage(),
    'a setup retried after it committed finds the account and changes nothing',
  )
  assert.equal((await visitor.stage()).kind, 'join')
  for (const code of [setupCode, 'a-brand-new-setup-code'])
    assert.equal(
      (
        await visitor.call('/api/access', {
          kind: 'account.setup',
          code,
          serverName: 'Hijacked',
          name: 'Intruder',
        })
      ).response.status,
      400,
    )
  await server.stop()
  await server.start()
  assert.doesNotMatch(server.logs(), /Huddle setup/)
  assert.equal(
    (
      await visitor.call('/api/access', {
        kind: 'account.setup',
        code: setupCode,
        serverName: 'Hijacked',
        name: 'Intruder',
      })
    ).response.status,
    400,
  )
  assert.equal((await call('/api/info', ServerInfo)).name, 'Integration studio')
  const seat = (await call('/api/snapshot', Snapshot, owner.login)).server
  assert.equal(seat.role, 'admin')
  assert.equal(seat.memberCount, 1)
  pass('onboarding needs the setup code, makes the admin, names the server, and cannot run twice')

  const code = await inviteCode(ownerClient)
  const memberClient = new Client(origin, 'colleague@huddle.test')
  const memberUser = await joinFriend(memberClient, code, 'Integration colleague')
  const member = account(memberClient, memberUser)
  const joined = await call('/api/snapshot', Snapshot, member.login)
  assert.equal(joined.server.role, 'member')
  assert.equal(joined.server.memberCount, 2)
  assert.deepEqual(
    await memberClient.act({ kind: 'account.join', code, name: 'Second try' }),
    await memberClient.stage(),
    'a join retried after it committed finds the account and renames nothing',
  )
  const memberInvite = await request('/api/invite', { login: member.login })
  assert.equal(memberInvite.response.status, 403)
  assert.deepEqual(memberInvite.data, { message: 'Only an admin can do that.' })
  for (const removed of ['/api/friend-invite', '/api/auth/sign-out'])
    assert.equal(
      (await request(removed, { login: owner.login, body: {} })).response.status,
      404,
      `${removed} is gone`,
    )
  const badJoin = await new Client(origin, 'outsider@huddle.test').call('/api/access', {
    kind: 'account.join',
    code: 'not-a-real-join-code-xx',
    name: 'Outsider',
  })
  assert.equal(badJoin.response.status, 400)
  assert.deepEqual(AccessError.parse(badJoin.value), { error: 'invalid' })
  assert.equal((await visitor.stage()).kind, 'join', 'reaching the server is not membership')
  assert.equal((await request('/api/snapshot', { login: visitor.login })).response.status, 401)
  const noIdentityJoin = await new Client(origin).call('/api/access', {
    kind: 'account.join',
    code,
    name: 'Nobody',
  })
  assert.equal(noIdentityJoin.response.status, 401, 'an invite without an identity admits nobody')
  const lateClient = new Client(origin, 'latefriend@huddle.test')
  const lateUser = await joinFriend(lateClient, code, 'Late colleague')
  const late = account(lateClient, lateUser)
  assert.equal((await call('/api/snapshot', Snapshot, owner.login)).server.memberCount, 3)
  pass(
    'friends join with the invite code and their identity, retries are idempotent, a bad code fails',
  )

  const roster = (await call('/api/members', Members, member.login)).members
  assert.deepEqual(
    roster.map(({ name, avatar, role }) => ({ name, avatar, role })),
    [
      { name: 'Integration owner', avatar: defaultMascot(owner.user.id), role: 'admin' },
      { name: 'Integration colleague', avatar: defaultMascot(member.user.id), role: 'member' },
      { name: 'Late colleague', avatar: defaultMascot(lateUser.id), role: 'member' },
    ],
  )
  assert.equal(roster[0]?.id, owner.user.id)
  assert.ok(roster.every((person) => Date.parse(person.joinedAt) <= Date.now()))
  assert.deepEqual(await call('/api/members', Members, owner.login), { members: roster })
  pass('every member sees the roster: admins first, with avatar and role')

  const linkClient = new Client(origin, 'linkfriend@huddle.test')
  const linkUser = await joinFriend(linkClient, code, 'Link friend')
  const linked = account(linkClient, linkUser)
  const listed = await accountLink(database.url)
  assert.equal(listed.code, 0, listed.stderr)
  assert.match(listed.stdout, /^ID\s+ROLE\s+NAME\s+OLD USERNAME\s+JOINED\s+LOGIN$/m)
  assert.match(
    listed.stdout,
    new RegExp(
      `^${owner.user.id}\\s+admin\\s+Integration owner\\s+-\\s+\\d{4}-\\d{2}-\\d{2}\\s+owner@huddle\\.test$`,
      'm',
    ),
  )
  assert.match(listed.stdout, /linkfriend@huddle\.test$/m)
  const movedAway = watch(linked.login, '0')
  await eventually(() => movedAway.ready, 'the friend watches before the login moves')
  const relinked = await accountLink(database.url, linkUser.id, 'renamed@huddle.test')
  assert.equal(relinked.code, 0, relinked.stderr)
  assert.match(relinked.stdout, /Linked renamed@huddle\.test to Link friend/)
  assert.match(relinked.stdout, /No other account held it/)
  assert.match(relinked.stdout, /linkfriend@huddle\.test no longer reaches this account/)
  assert.equal(await movedAway.closed, 1008, 'the old login loses its socket within a second')
  assert.equal((await request('/api/snapshot', { login: linked.login })).response.status, 401)
  assert.equal((await new Client(origin, linked.login).stage()).kind, 'join')
  accounts.delete(linked.login)
  accounts.set('renamed@huddle.test', linkUser.id)
  assert.equal(
    (await call('/api/snapshot', Snapshot, 'renamed@huddle.test')).server.role,
    'member',
    'the new login reaches the same account',
  )
  const heldByOther = watch('renamed@huddle.test', '0')
  await eventually(() => heldByOther.ready, 'the socket is live before its login moves on')
  const takeover = await accountLink(database.url, lateUser.id, 'renamed@huddle.test')
  assert.equal(takeover.code, 0, takeover.stderr)
  assert.match(takeover.stdout, new RegExp(`It came from Link friend \\(${linkUser.id}\\)`))
  assert.equal(
    await heldByOther.closed,
    1008,
    'a socket never starts streaming another account when its login moves',
  )
  const stale = await request('/api/rooms', {
    login: 'renamed@huddle.test',
    body: { name: 'Sent for the old account' },
  })
  assert.equal(stale.response.status, 401, 'a page still naming the old account cannot act')
  assert.deepEqual(stale.data, { error: 'no_access' })
  accounts.set('renamed@huddle.test', lateUser.id)
  assert.equal((await new Client(origin, 'renamed@huddle.test').stage()).kind === 'ready', true)
  const restored = await accountLink(database.url, lateUser.id, late.login)
  assert.match(restored.stdout, /renamed@huddle\.test no longer reaches this account/)
  accounts.delete('renamed@huddle.test')
  const unknownAccount = await accountLink(database.url, 'nobody-here', 'x@huddle.test')
  assert.notEqual(unknownAccount.code, 0)
  assert.match(unknownAccount.stderr, /No single member has the ID or old username nobody-here/)
  const badLogin = await accountLink(database.url, lateUser.id, 'not a login')
  assert.notEqual(badLogin.code, 0)
  assert.match(badLogin.stderr, /is not a Tailscale login/)
  const legacyFixture = new pg.Client({ connectionString: database.url })
  await legacyFixture.connect()
  try {
    await legacyFixture.query(
      `UPDATE "user" SET tailscale_login = NULL, legacy_username = 'oldfriend' WHERE id = $1`,
      [linkUser.id],
    )
  } finally {
    await legacyFixture.end()
  }
  assert.match(
    (await accountLink(database.url)).stdout,
    /oldfriend\s+\d{4}-\d{2}-\d{2}\s+\(none\)$/m,
  )
  const byUsername = await accountLink(database.url, 'oldfriend', 'back@huddle.test')
  assert.equal(byUsername.code, 0, byUsername.stderr)
  assert.equal(
    (await new Client(origin, 'back@huddle.test').stage()).kind,
    'ready',
    'an old username finds the account to bind',
  )
  pass(
    'account:link lists accounts, binds by ID or old username, reports what moved, and the old login loses HTTP and its socket at once',
  )

  const studio = await call('/api/rooms', Room, owner.login, { name: 'Studio' })
  const channel = await call('/api/channels', Channel, owner.login, {
    roomId: studio.id,
    name: 'general',
    kind: 'text',
  })
  assert.equal(
    (
      await request('/api/channels', {
        login: member.login,
        body: { roomId: studio.id, name: 'forbidden', kind: 'text' },
      })
    ).response.status,
    403,
  )
  assert.equal(
    (await request('/api/rooms', { login: member.login, body: { name: 'Forbidden' } })).response
      .status,
    403,
  )
  pass('only admins create rooms and channels')
  const snapshot = await call('/api/snapshot', Snapshot, owner.login)
  const first = watch(owner.login, snapshot.cursor)
  const second = watch(member.login, snapshot.cursor)
  await eventually(() => first.ready && second.ready, 'Both clients are subscribed')
  const input = {
    channelId: channel.id,
    retryId: randomUUID(),
    body: 'A real persistent conversation.',
  }
  const [message, duplicate] = await Promise.all([
    call('/api/messages', Message, owner.login, input),
    call('/api/messages', Message, owner.login, input),
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
    (await request('/api/messages', { login: owner.login, body: { ...input, body: 'Changed' } }))
      .response.status,
    409,
  )
  const anotherChannel = await call('/api/channels', Channel, owner.login, {
    roomId: studio.id,
    name: 'design',
    kind: 'text',
  })
  assert.equal(
    (
      await request('/api/messages', {
        login: owner.login,
        body: { ...input, channelId: anotherChannel.id },
      })
    ).response.status,
    409,
  )
  const history = await call(`/api/messages?channelId=${channel.id}`, Message.array(), owner.login)
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
  const offline = await call('/api/messages', Message, owner.login, {
    channelId: channel.id,
    retryId: randomUUID(),
    body: 'Sent while a client was disconnected.',
  })
  const offlineChannel = await call('/api/channels', Channel, owner.login, {
    roomId: studio.id,
    name: 'replay',
    kind: 'text',
  })
  const reconnected = watch(member.login, cursor)
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
  const beforeOverlap = await call('/api/snapshot', Snapshot, owner.login)
  const overlap = await call('/api/messages', Message, owner.login, {
    channelId: channel.id,
    retryId: randomUUID(),
    body: 'Between snapshot and watch.',
  })
  const racing = watch(owner.login, beforeOverlap.cursor)
  await eventually(
    () =>
      racing.events.some(
        (event) => event.kind === 'message.created' && event.message.id === overlap.id,
      ),
    'Snapshot/watch overlap is recovered',
  )
  await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      call('/api/messages', Message, owner.login, {
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
  await rejectedFrame({ kind: 'send', body: 'socket cannot mutate' }, owner.login)
  await rejectedFrame({ kind: 'watch', after: '0', ticket: 'x'.repeat(43) }, owner.login)
  await rejectedFrame({ kind: 'watch', after: '0', token: 'old-bearer' }, owner.login)
  await rejectedFrame({ kind: 'watch', after: '0' }, 'stranger@huddle.test')
  const noIdentitySocket = new WebSocket(wsURL, { origin })
  sockets.add(noIdentitySocket)
  noIdentitySocket.on('error', () => {})
  noIdentitySocket.on('open', () => noIdentitySocket.send('{"kind":"watch","after":"0"}'))
  const [noIdentityCode] = await once(noIdentitySocket, 'close')
  assert.equal(noIdentityCode, 1008, 'a socket without identity closes')
  assert.equal(
    (
      await request('/api/messages', {
        login: owner.login,
        requestOrigin: 'https://untrusted.test',
        body: input,
      })
    ).response.status,
    403,
  )
  const noOrigin = await fetch(`${origin}/api/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Huddle-User': owner.user.id,
      ...tailscale(owner.login),
    },
    body: JSON.stringify(input),
  })
  assert.equal(noOrigin.status, 403, 'a POST without Origin is always refused')
  const opaque = await request('/api/rooms', {
    login: owner.login,
    requestOrigin: 'null',
    body: { name: 'From a sandbox' },
  })
  assert.equal(opaque.response.status, 403, 'an opaque origin is refused')
  for (const site of ['cross-site', 'same-site']) {
    const probe = await fetch(`${origin}/api/snapshot`, {
      headers: { 'Sec-Fetch-Site': site, ...tailscale(owner.login) },
    })
    assert.equal(probe.status, 403, `a no-cors GET from a ${site} page is refused`)
  }
  const sameOriginRead = await fetch(`${origin}/api/snapshot`, {
    headers: { 'Sec-Fetch-Site': 'same-origin', ...tailscale(owner.login) },
  })
  assert.equal(sameOriginRead.status, 200, 'a same-origin read needs no Origin')
  await refusedUpgrade({ headers: tailscale(owner.login) })
  await refusedUpgrade({ origin: 'null', headers: tailscale(owner.login) })
  const preflight = (from: string) =>
    fetch(`${origin}/api/messages`, {
      method: 'OPTIONS',
      headers: {
        Origin: from,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,x-huddle-user',
      },
    })
  for (const desktop of ['tauri://localhost', 'https://tauri.localhost']) {
    const answer = await preflight(desktop)
    assert.equal(answer.status, 204, `${desktop} may preflight`)
    assert.equal(answer.headers.get('access-control-allow-origin'), desktop)
    assert.equal(
      answer.headers.get('access-control-allow-headers'),
      'Content-Type, X-Huddle-User',
      'identity headers are never allowed from a page',
    )
    assert.equal(answer.headers.get('access-control-allow-credentials'), null)
  }
  assert.equal((await preflight('https://evil.test')).status, 403)
  assert.equal((await preflight('http://tauri.localhost')).status, 403)
  const mismatch = await fetch(`${origin}/api/rooms`, {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      'X-Huddle-User': member.user.id,
      ...tailscale(owner.login),
    },
    body: JSON.stringify({ name: 'Wrong person' }),
  })
  assert.equal(mismatch.status, 401, 'a page naming another account cannot act')
  assert.deepEqual(await mismatch.json(), { error: 'no_access' })
  const absent = await fetch(`${origin}/api/rooms`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', ...tailscale(owner.login) },
    body: JSON.stringify({ name: 'No expectation' }),
  })
  assert.equal(absent.status, 401, 'a data POST must name its account')
  const accessMismatch = await fetch(`${origin}/api/access`, {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      'X-Huddle-User': member.user.id,
      ...tailscale(owner.login),
    },
    body: JSON.stringify({
      kind: 'profile.save',
      profile: { name: 'Wrong person', avatar: ownerUser.avatar },
    }),
  })
  assert.equal(accessMismatch.status, 401, 'the access route checks a named account too')
  const strangerNaming = await fetch(`${origin}/api/access`, {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      'X-Huddle-User': member.user.id,
      ...tailscale('stranger@huddle.test'),
    },
    body: JSON.stringify({ kind: 'account.join', code, name: 'Stranger' }),
  })
  assert.equal(strangerNaming.status, 401, 'a stale page cannot join for a new login')
  assert.equal(
    (await request('/api/messages', { login: owner.login, body: { ...input, body: '' } })).response
      .status,
    400,
  )
  await refusedUpgrade({ origin: 'https://untrusted.test', headers: tailscale(owner.login) })
  assert.equal(
    (await request('/api/snapshot', { login: owner.login, requestOrigin: 'tauri://localhost' }))
      .response.status,
    200,
  )
  assert.equal(
    (
      await request('/api/snapshot', {
        login: owner.login,
        requestOrigin: 'https://tauri.localhost',
      })
    ).response.status,
    200,
  )
  assert.equal(
    (
      await request('/api/snapshot', {
        login: owner.login,
        requestOrigin: 'http://tauri.localhost',
      })
    ).response.status,
    403,
    'the plain http desktop origin is gone',
  )
  pass(
    'malformed frames, sockets without a member, cross-site contexts, and a page naming the wrong account all reject',
  )
  const snapshotOf = (login: string) => call('/api/snapshot', Snapshot, login)
  const beforeRooms = await snapshotOf(owner.login)
  assert.deepEqual(beforeRooms.rooms, [studio])
  assert.equal(
    (
      await request('/api/rooms', {
        login: member.login,
        body: { name: 'Lounge' },
      })
    ).response.status,
    403,
  )
  const lounge = await call('/api/rooms', Room, owner.login, { name: ' Lounge ' })
  assert.deepEqual(lounge, { id: lounge.id, name: 'Lounge' })
  assert.equal(
    (
      await request('/api/rooms', {
        login: owner.login,
        body: { name: 'LOUNGE' },
      })
    ).response.status,
    409,
  )
  assert.equal(
    (
      await request('/api/rooms', {
        login: owner.login,
        body: { name: 'Extra field', roomId: studio.id },
      })
    ).response.status,
    400,
  )
  const lobby = await call('/api/channels', Channel, owner.login, {
    roomId: lounge.id,
    name: 'general',
    kind: 'text',
  })
  assert.deepEqual(lobby, { id: lobby.id, roomId: lounge.id, name: 'general', kind: 'text' })
  assert.notEqual(lobby.id, channel.id)
  assert.equal(
    (
      await request('/api/channels', {
        login: owner.login,
        body: { roomId: lounge.id, name: 'General', kind: 'text' },
      })
    ).response.status,
    409,
  )
  assert.equal(
    (
      await request('/api/channels', {
        login: owner.login,
        body: { roomId: randomUUID(), name: 'nowhere', kind: 'text' },
      })
    ).response.status,
    404,
  )
  const afterRooms = await snapshotOf(owner.login)
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
  const roomReplay = watch(member.login, beforeRooms.cursor)
  await eventually(() => roomReplay.events.length >= 2, 'Room events replay')
  assert.deepEqual(roomReplay.events.slice(0, 2), [
    { kind: 'room.created', cursor: String(BigInt(beforeRooms.cursor) + 1n), room: lounge },
    { kind: 'channel.created', cursor: String(BigInt(beforeRooms.cursor) + 2n), channel: lobby },
  ])
  pass('admins create rooms with unique names; channel names are unique per room; rooms replay')

  const beforeVoice = await snapshotOf(owner.login)
  assert.equal(
    (
      await request('/api/channels', {
        login: owner.login,
        body: { roomId: lounge.id, name: 'nokind' },
      })
    ).response.status,
    400,
    'a channel must state its kind',
  )
  assert.equal(
    (
      await request('/api/channels', {
        login: owner.login,
        body: { roomId: lounge.id, name: 'video', kind: 'video' },
      })
    ).response.status,
    400,
    'a channel kind is text or voice',
  )
  assert.equal(
    (
      await request('/api/channels', {
        login: owner.login,
        body: { roomId: lounge.id, name: 'general', kind: 'voice' },
      })
    ).response.status,
    409,
    'text and voice channels share one namespace in a room',
  )
  const hangout = await call('/api/channels', Channel, owner.login, {
    roomId: lounge.id,
    name: 'hangout',
    kind: 'voice',
  })
  assert.deepEqual(hangout, { id: hangout.id, roomId: lounge.id, name: 'hangout', kind: 'voice' })
  const voiceReplay = watch(member.login, beforeVoice.cursor)
  await eventually(() => voiceReplay.events.length >= 1, 'The voice channel replays')
  assert.deepEqual(voiceReplay.events, [
    {
      kind: 'channel.created',
      cursor: String(BigInt(beforeVoice.cursor) + 1n),
      channel: hangout,
    },
  ])
  const voicePost = await request('/api/messages', {
    login: member.login,
    body: { channelId: hangout.id, retryId: randomUUID(), body: 'Anyone here?' },
  })
  assert.equal(voicePost.response.status, 409)
  assert.deepEqual(voicePost.data, { message: 'Voice channels do not hold messages.' })
  assert.deepEqual(
    await call(`/api/messages?channelId=${hangout.id}`, Message.array(), owner.login),
    [],
    'a rejected voice post leaves no message',
  )
  const afterVoice = await snapshotOf(owner.login)
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

  const askForVoice = (headers: Headers, body: string) =>
    fetch(`${origin}/api/voice/token`, { method: 'POST', headers, body })
  const joinHangout = JSON.stringify({ channelId: hangout.id })
  assert.equal(
    (await askForVoice(headersFor(undefined, origin, true), joinHangout)).status,
    401,
    'anonymous cannot ask for a voice token',
  )
  assert.equal(
    (await askForVoice(headersFor('stranger@huddle.test', origin, true), joinHangout)).status,
    401,
    'a login with no account cannot ask for a voice token',
  )
  assert.equal(
    (await askForVoice(headersFor(member.login, origin, false), joinHangout)).status,
    401,
    'a voice token request must carry X-Huddle-User',
  )
  assert.equal(
    (await askForVoice(headersFor(member.login, 'https://evil.test', true), joinHangout)).status,
    403,
    'a page on another site cannot ask for a voice token',
  )
  const textVoice = await request('/api/voice/token', {
    login: member.login,
    body: { channelId: lobby.id },
  })
  assert.equal(textVoice.response.status, 409)
  assert.deepEqual(textVoice.data, { message: 'Text channels do not carry voice.' })
  for (const who of [member.login, owner.login, member.login]) {
    const unknown = await request('/api/voice/token', {
      login: who,
      body: { channelId: randomUUID() },
    })
    assert.equal(unknown.response.status, 404)
    assert.deepEqual(unknown.data, { message: 'Channel not found.' })
  }
  for (const body of [
    '{',
    '{}',
    JSON.stringify({ channelId: 'not-a-uuid' }),
    JSON.stringify({ channelId: hangout.id, room: 'another' }),
  ])
    assert.equal(
      (await askForVoice(headersFor(member.login, origin, true), body)).status,
      400,
      `a malformed voice token request: ${body}`,
    )
  pass('a voice token needs an account, this origin, X-Huddle-User, and a known voice channel')

  const validateVoice = (token: string) =>
    fetch(`${livekit.http}/rtc/validate?access_token=${encodeURIComponent(token)}`)
  for (const person of [member, owner]) {
    const grant = await call('/api/voice/token', VoiceGrant, person.login, {
      channelId: hangout.id,
    })
    assert.equal(grant.url, livekit.url)
    const [header = '', payload = '', signature = ''] = grant.token.split('.')
    assert.equal(
      signature,
      createHmac('sha256', livekit.secret).update(`${header}.${payload}`).digest('base64url'),
      'the token is signed with the shared secret',
    )
    const decode = (part: string): unknown =>
      JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    assert.deepEqual(decode(header), { alg: 'HS256' })
    const { exp, nbf, ...claims } = z
      .looseObject({ exp: z.number(), nbf: z.number() })
      .parse(decode(payload))
    assert.deepEqual(claims, {
      iss: livekit.key,
      sub: person.user.id,
      name: person.user.name,
      video: {
        room: hangout.id,
        roomJoin: true,
        canSubscribe: true,
        canPublish: true,
        canPublishSources: ['microphone'],
        canPublishData: false,
        canUpdateOwnMetadata: false,
      },
    })
    assert.equal(exp - nbf, 60, 'a voice token lives for 60 seconds')
    assert.ok(Math.abs(nbf - Date.now() / 1000) < 10, 'a voice token starts now')

    const accepted = await validateVoice(grant.token)
    assert.equal(accepted.status, 200, `LiveKit: ${await accepted.text()}`)
    const flipped = signature.startsWith('A') ? `B${signature.slice(1)}` : `A${signature.slice(1)}`
    const forgedClaims = Buffer.from(
      JSON.stringify({ ...claims, exp, nbf, video: { room: hangout.id, roomAdmin: true } }),
    ).toString('base64url')
    const wrongSecret = createHmac('sha256', 'x'.repeat(64))
      .update(`${header}.${payload}`)
      .digest('base64url')
    for (const [label, token] of [
      ['a changed signature', `${header}.${payload}.${flipped}`],
      ['changed claims', `${header}.${forgedClaims}.${signature}`],
      ['another secret', `${header}.${payload}.${wrongSecret}`],
    ] as const)
      assert.equal((await validateVoice(token)).status, 401, `LiveKit refuses ${label}`)
  }
  assert.equal((await call('/api/info', ServerInfo)).voice, true)
  const presenceWatch = watch(owner.login, '0')
  await eventually(() => presenceWatch.frames.length > 0, 'the socket delivered a frame')
  assert.ok(
    Array.isArray(
      z.object({ voice: z.unknown() }).parse(JSON.parse(presenceWatch.frames[0] ?? '')).voice,
    ),
    'a server with voice carries the list of who is in a call on each frame',
  )
  presenceWatch.socket.close()
  assert.equal(
    ServerInfo.parse({
      name: 'Older server',
      setup: 'complete',
      serverUrl: origin,
      websocketUrl: wsURL,
    }).voice,
    false,
    'a new client reads an older server as having no voice',
  )
  pass('members and admins get a 60-second microphone token that real LiveKit accepts untampered')

  const sent: Message[] = []
  for (const body of ['First unread', 'Second unread', '@integration OWNER, can you look?'])
    sent.push(
      await call('/api/messages', Message, member.login, {
        channelId: lobby.id,
        retryId: randomUUID(),
        body,
      }),
    )
  const [firstUnread, , mention] = sent
  assert(firstUnread && mention)
  assert.deepEqual((await snapshotOf(owner.login)).unread, [
    { channelId: lobby.id, count: 3, mentions: 1 },
  ])
  assert.equal(
    (await snapshotOf(member.login)).unread.some((item) => item.channelId === lobby.id),
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

  const markRead = (login: string, body: unknown) => request('/api/read', { login, body })
  const cleared = await markRead(owner.login, { channelId: lobby.id, cursor: firstUnread.cursor })
  assert.equal(cleared.response.status, 200)
  assert.deepEqual(cleared.data, {})
  assert.deepEqual((await snapshotOf(owner.login)).unread, [
    { channelId: lobby.id, count: 2, mentions: 1 },
  ])
  assert.equal(
    (await markRead(owner.login, { channelId: lobby.id, cursor: mention.cursor })).response.status,
    200,
  )
  assert.deepEqual((await snapshotOf(owner.login)).unread, [])
  assert.equal(
    (await markRead(owner.login, { channelId: lobby.id, cursor: firstUnread.cursor })).response
      .status,
    200,
  )
  assert.deepEqual((await snapshotOf(owner.login)).unread, [])
  for (const cursor of ['9000000000000000000', '9999999999999999999'])
    assert.equal(
      (await markRead(owner.login, { channelId: lobby.id, cursor })).response.status,
      200,
    )
  await call('/api/messages', Message, member.login, {
    channelId: lobby.id,
    retryId: randomUUID(),
    body: 'Fourth unread',
  })
  assert.deepEqual((await snapshotOf(owner.login)).unread, [
    { channelId: lobby.id, count: 1, mentions: 0 },
  ])
  const memberBefore = await snapshotOf(member.login)
  assert.deepEqual(memberBefore.unread, [{ channelId: channel.id, count: 16, mentions: 0 }])
  assert.equal(
    (await markRead(member.login, { channelId: channel.id, cursor: memberBefore.cursor })).response
      .status,
    200,
  )
  assert.deepEqual((await snapshotOf(member.login)).unread, [])
  pass('read markers clear unread and mentions, never regress, and stop at the server cursor')

  assert.equal(
    (await markRead(owner.login, { channelId: randomUUID(), cursor: '1' })).response.status,
    404,
  )
  assert.equal(
    (await markRead(owner.login, { kind: 'all', cursor: '1' })).response.status,
    400,
    'the all-channels read marker is gone',
  )
  assert.equal(
    (await request('/api/home', { login: owner.login })).response.status,
    404,
    'the home feed endpoint is gone',
  )
  pass('read markers reject unknown channels and the removed feed endpoints are gone')

  const thirdClient = new Client(origin, 'thirdparty@huddle.test')
  const thirdUser = await joinFriend(thirdClient, code, 'Third party')
  const third = account(thirdClient, thirdUser)
  const secret = `direct-secret-${randomUUID()}`
  const open = (login: string, userId: string) =>
    call('/api/direct/conversations', DirectConversation, login, { userId })
  const beforeDirect = await snapshotOf(owner.login)
  const conversation = await open(owner.login, member.user.id)
  assert.deepEqual(conversation, {
    id: conversation.id,
    peerId: member.user.id,
    latest: null,
    unread: 0,
  })
  assert.equal((await open(owner.login, member.user.id)).id, conversation.id)
  const fromPeer = await open(member.login, owner.user.id)
  assert.equal(fromPeer.id, conversation.id, 'find-or-create finds one row from either direction')
  assert.equal(fromPeer.peerId, owner.user.id)
  const afterOpen = await snapshotOf(owner.login)
  assert.equal(afterOpen.cursor, beforeDirect.cursor, 'opening a conversation emits no event')
  assert.deepEqual(afterOpen.directs, [])
  assert.deepEqual(
    (await snapshotOf(member.login)).directs,
    [],
    'an empty conversation does not appear for the peer',
  )
  const toSelf = await request('/api/direct/conversations', {
    login: owner.login,
    body: { userId: owner.user.id },
  })
  assert.equal(toSelf.response.status, 400)
  assert.deepEqual(toSelf.data, { message: 'You cannot message yourself.' })
  assert.equal(
    (
      await request('/api/direct/conversations', {
        login: owner.login,
        body: { userId: 'nobody-here' },
      })
    ).response.status,
    404,
  )
  assert.equal(
    (
      await request('/api/direct/conversations', {
        login: owner.login,
        body: { userId: member.user.id, extra: true },
      })
    ).response.status,
    400,
    'direct inputs are strict',
  )
  pass('find-or-create is idempotent both ways, silent, and rejects self and non-members')

  const bystander = watch(third.login, afterOpen.cursor)
  const ownerLive = watch(owner.login, afterOpen.cursor)
  const memberLive = watch(member.login, afterOpen.cursor)
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
    call('/api/direct/messages', DirectMessage, owner.login, directInput),
    call('/api/direct/messages', DirectMessage, owner.login, directInput),
  ])
  assert.deepEqual(dm, dmDuplicate, 'an exact retry returns the stored message')
  assert.equal(dm.conversationId, conversation.id)
  assert.equal(dm.authorId, owner.user.id)
  const reply = await call('/api/direct/messages', DirectMessage, member.login, {
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
  const ownerDirects = (await snapshotOf(owner.login)).directs
  assert.deepEqual(ownerDirects, [
    { id: conversation.id, peerId: member.user.id, latest: reply, unread: 1 },
  ])
  const memberDirects = (await snapshotOf(member.login)).directs
  assert.deepEqual(memberDirects, [
    { id: conversation.id, peerId: owner.user.id, latest: reply, unread: 1 },
  ])
  const directPath = `/api/direct/messages?conversationId=${conversation.id}`
  assert.deepEqual(await call(directPath, DirectMessage.array(), member.login), [dm, reply])
  pass('participants exchange messages live, with retry deduplication and per-reader unread')

  const roomAfterDirect = await call('/api/messages', Message, member.login, {
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
  const fromZero = watch(third.login, '0')
  await eventually(
    () =>
      fromZero.events.some(
        (event) => event.kind === 'message.created' && event.message.id === roomAfterDirect.id,
      ),
    'a replay from cursor 0 reaches the end of the log',
  )
  assert.deepEqual(leaks(fromZero.frames.join('\n')), [], 'nothing private in replay from 0')
  const participantReplay = watch(member.login, '0')
  await eventually(
    () => sawDirect(participantReplay.events, reply.id),
    'the same replay does carry the messages to a participant',
  )
  fromZero.socket.terminate()
  participantReplay.socket.terminate()

  const thirdSnapshot = await rawText('/api/snapshot', third.login)
  assert.equal(thirdSnapshot.status, 200)
  assert.deepEqual(leaks(thirdSnapshot.text), [], 'nothing private in the snapshot')
  assert.deepEqual(Snapshot.parse(JSON.parse(thirdSnapshot.text)).directs, [])
  const notFound = JSON.stringify({ message: 'Conversation not found.' })
  const probes = (id: string) => [
    rawText(`/api/direct/messages?conversationId=${id}`, third.login),
    rawText('/api/direct/messages', third.login, {
      conversationId: id,
      retryId: randomUUID(),
      body: 'Let me in',
    }),
    rawText('/api/direct/read', third.login, { conversationId: id, cursor: '1' }),
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
    (await rawText(`/api/messages?channelId=${conversation.id}`, third.login)).status,
    404,
    'a conversation ID is not a channel',
  )
  for (const path of ['/api/snapshot', '/api/members', `/api/messages?channelId=${channel.id}`])
    assert.deepEqual(
      leaks((await rawText(path, third.login)).text),
      [],
      `nothing private in ${path}`,
    )
  assert.deepEqual(
    (await snapshotOf(owner.login)).directs,
    ownerDirects,
    'the stranger changed nothing',
  )
  pass(
    'a third member finds nothing in snapshot, replay, or a live watch, and gets the same 404 as for a random ID',
  )

  const conflict = JSON.stringify({
    message: 'This retry ID was already used for a different message.',
  })
  const changedBody = await rawText('/api/direct/messages', owner.login, {
    ...directInput,
    body: 'Changed',
  })
  assert.equal(changedBody.status, 409)
  assert.equal(changedBody.text, conflict)
  const elsewhere = await open(owner.login, third.user.id)
  assert.notEqual(elsewhere.id, conversation.id)
  const otherConversation = await rawText('/api/direct/messages', owner.login, {
    ...directInput,
    conversationId: elsewhere.id,
  })
  assert.equal(otherConversation.status, 409)
  assert.equal(otherConversation.text, conflict, 'a conflict returns no body')
  assert.deepEqual(
    await call(
      `/api/direct/messages?conversationId=${elsewhere.id}`,
      DirectMessage.array(),
      owner.login,
    ),
    [],
  )
  assert.deepEqual(
    (await snapshotOf(third.login)).directs,
    [],
    'a failed retry leaves the peer with nothing to see',
  )
  assert.equal(
    (
      await request('/api/direct/messages', {
        login: owner.login,
        body: { ...directInput, retryId: randomUUID(), body: '   ' },
      })
    ).response.status,
    400,
  )
  assert.equal(
    (await request('/api/direct/messages?conversationId=not-a-uuid', { login: owner.login }))
      .response.status,
    400,
  )
  pass('a reused retry ID is a conflict that returns no body, and input is validated')

  const readDirect = (login: string, cursor: string) =>
    request('/api/direct/read', { login, body: { conversationId: conversation.id, cursor } })
  const unreadOf = async (login: string) =>
    (await snapshotOf(login)).directs.find((item) => item.id === conversation.id)?.unread
  const clearedDirect = await readDirect(member.login, dm.cursor)
  assert.equal(clearedDirect.response.status, 200)
  assert.deepEqual(clearedDirect.data, {})
  assert.equal(await unreadOf(member.login), 0, 'your own reply is never unread')
  assert.equal(await unreadOf(owner.login), 1, 'reading is private to each participant')
  assert.equal((await readDirect(owner.login, reply.cursor)).response.status, 200)
  assert.equal(await unreadOf(owner.login), 0)
  assert.equal((await readDirect(owner.login, dm.cursor)).response.status, 200)
  assert.equal(await unreadOf(owner.login), 0, 'a read marker never moves back')
  assert.equal((await readDirect(owner.login, '9999999999999999999')).response.status, 200)
  const afterCap = await call('/api/direct/messages', DirectMessage, member.login, {
    conversationId: conversation.id,
    retryId: randomUUID(),
    body: 'After the capped read marker',
  })
  assert.equal(await unreadOf(owner.login), 1, 'a read marker stops at the server cursor')
  pass('direct read markers clear unread per reader, never regress, and stop at the server cursor')

  const paged = await open(third.login, member.user.id)
  const sentPages: DirectMessage[] = []
  for (let index = 0; index < 101; index++)
    sentPages.push(
      await call('/api/direct/messages', DirectMessage, third.login, {
        conversationId: paged.id,
        retryId: randomUUID(),
        body: `Page line ${index}`,
      }),
    )
  const pagedPath = `/api/direct/messages?conversationId=${paged.id}`
  const newestPage = await call(pagedPath, DirectMessage.array(), member.login)
  assert.deepEqual(newestPage, sentPages.slice(1))
  assert.deepEqual(
    await call(`${pagedPath}&before=${newestPage[0]?.cursor}`, DirectMessage.array(), member.login),
    sentPages.slice(0, 1),
  )
  assert.deepEqual(
    await call(`${pagedPath}&before=9999999999999999999`, DirectMessage.array(), member.login),
    sentPages.slice(1),
  )
  assert.deepEqual(
    (await snapshotOf(member.login)).directs.map((item) => item.id),
    [paged.id, conversation.id],
    'the snapshot lists the most recent conversation first',
  )
  pass('direct history pages 100 at a time, oldest first, and takes any valid before cursor')

  const photoStatus = async (id: string, login: string) =>
    (
      await fetch(`${origin}/api/account/photo/${id}`, {
        headers: { Origin: origin, ...tailscale(login) },
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
      headers: {
        Origin: origin,
        'X-Huddle-User': third.user.id,
        ...tailscale(third.login),
      },
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
  assert.equal(await photoStatus(privatePhoto, member.login), 200, 'a current avatar is visible')
  const withOwner = await open(third.login, owner.user.id)
  const withPhoto = await call('/api/direct/messages', DirectMessage, third.login, {
    conversationId: withOwner.id,
    retryId: randomUUID(),
    body: 'Sent with a photo avatar.',
  })
  assert.deepEqual(withPhoto.authorAvatar, { kind: 'photo', uploadId: privatePhoto })
  await saveAvatar({ kind: 'mascot', shape: 'circle', color: 'teal' })
  assert.equal(await photoStatus(privatePhoto, owner.login), 200, 'the peer still sees it')
  assert.equal(await photoStatus(privatePhoto, third.login), 200, 'the author still sees it')
  assert.equal(
    await photoStatus(privatePhoto, member.login),
    await photoStatus(unusedPhoto, member.login),
    'a photo only a direct message uses looks like any unreachable photo to a third member',
  )
  assert.equal(await photoStatus(privatePhoto, member.login), 400)
  for (const path of ['/api/snapshot', directPath])
    assert.equal(
      (await request(path, { login: owner.login })).response.headers.get('cache-control'),
      'no-store',
    )
  pass(
    'a photo used only in a direct message reveals nothing to a third member, and data responses are not cacheable',
  )

  const scratch = new pg.Client({ connectionString: database.url })
  await scratch.connect()
  try {
    await scratch.query('DELETE FROM member WHERE user_id = $1', [lateUser.id])
  } finally {
    await scratch.end()
  }
  for (const answer of await Promise.all([
    request(directPath, { login: late.login }),
    request('/api/direct/conversations', {
      login: late.login,
      body: { userId: owner.user.id },
    }),
    request('/api/direct/messages', {
      login: late.login,
      body: { conversationId: conversation.id, retryId: randomUUID(), body: 'Hello?' },
    }),
    request('/api/direct/read', {
      login: late.login,
      body: { conversationId: conversation.id, cursor: '1' },
    }),
  ])) {
    assert.equal(answer.response.status, 401)
    assert.deepEqual(answer.data, { error: 'no_access' })
  }
  assert.equal(
    (
      await request('/api/direct/conversations', {
        login: owner.login,
        body: { userId: lateUser.id },
      })
    ).response.status,
    404,
    'an account that is not a member cannot be messaged',
  )
  pass('every direct operation requires membership, and non-member targets are rejected')

  const fakeTailscale = await mkdtemp(join(tmpdir(), 'huddle-userspace-'))
  try {
    await writeFile(join(fakeTailscale, 'tailscale'), `#!/bin/sh\nprintf '{"TUN":false}'\n`, {
      mode: 0o755,
    })
    await assert.rejects(
      startServer({
        databaseUrl: database.url,
        port: port + 4,
        env: { PATH: `${fakeTailscale}:${process.env.PATH ?? ''}` },
      }),
      /userspace mode/,
    )
  } finally {
    await rm(fakeTailscale, { recursive: true, force: true })
  }
  pass('the server refuses to start when Tailscale runs in userspace mode')

  const aging = await startServer({
    databaseUrl: database.url,
    port: port + 2,
    env: { SOCKET_MAX_AGE_SECONDS: '2', LIVEKIT_API_SECRET: undefined },
  })
  try {
    const opened = Date.now()
    const agingSocket = () =>
      new WebSocket(aging.websocket, { origin: aging.origin, headers: tailscale(owner.login) })
    const socket = agingSocket()
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('open', () => socket.send(JSON.stringify({ kind: 'watch', after: '0' })))
    const pages: string[] = []
    socket.on('message', (data) => pages.push(data.toString()))
    const [closeCode, closeReason] = await once(socket, 'close')
    const lived = Date.now() - opened
    assert.equal(closeCode, 4001, 'an old socket closes with the reconnect code')
    assert.match(String(closeReason), /re-check access/)
    assert.ok(lived >= 1900 && lived < 3500, `the socket lived 2 to 2.2 seconds, not ${lived}ms`)
    assert.ok(pages.length > 0, 'the socket delivered events until it aged out')
    assert.ok(
      pages.every((page) => !Object.hasOwn(z.looseObject({}).parse(JSON.parse(page)), 'voice')),
      'a server with no voice sends no voice list',
    )
    const last = EventPage.parse(JSON.parse(pages.at(-1) ?? '')).events
    const cursorAtClose = last.at(-1)?.cursor ?? (await snapshotOf(owner.login)).cursor
    const whileAway = await call('/api/messages', Message, owner.login, {
      channelId: channel.id,
      retryId: randomUUID(),
      body: 'Sent while the socket was reconnecting.',
    })
    const again = agingSocket()
    sockets.add(again)
    again.on('error', () => {})
    const seen: ServerEvent[] = []
    again.on('open', () => again.send(JSON.stringify({ kind: 'watch', after: cursorAtClose })))
    again.on('message', (data) => seen.push(...EventPage.parse(JSON.parse(data.toString())).events))
    await eventually(
      () =>
        seen.some((event) => event.kind === 'message.created' && event.message.id === whileAway.id),
      'the reconnected socket replays what it missed',
    )
    again.terminate()
    pass('a socket ages out with code 4001 and a reconnect replays the gap under fresh attestation')

    const voiceless = new Client(aging.origin, owner.login)
    await voiceless.stage()
    assert.equal(ServerInfo.parse((await voiceless.call('/api/info')).value).voice, false)
    const unconfigured = await voiceless.call('/api/voice/token', { channelId: hangout.id })
    assert.equal(unconfigured.response.status, 503)
    assert.deepEqual(unconfigured.value, { message: 'Voice is not set up on this server.' })
    pass('a server with no LiveKit secret reports no voice and answers 503')
  } finally {
    await aging.stop()
  }

  for (const socket of sockets) socket.terminate()
  await server.stop()
  await server.start()
  const persisted = await call(
    `/api/messages?channelId=${channel.id}`,
    Message.array(),
    owner.login,
  )
  assert.ok(persisted.some((item) => item.id === offline.id))
  assert.deepEqual(await call(directPath, DirectMessage.array(), owner.login), [
    dm,
    reply,
    afterCap,
  ])
  const thirdAfterRestart = watch(third.login, '0')
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
  const restarted = watch(owner.login, cursor)
  await eventually(
    () =>
      restarted.events.some(
        (event) => event.kind === 'message.created' && event.message.id === offline.id,
      ),
    'Events survive a server restart',
  )
  pass('messages, direct messages, accounts, and filtered replay survive an actual server restart')
} catch (error) {
  process.stderr.write(server.logs())
  throw error
} finally {
  for (const socket of sockets) socket.terminate()
  await server.stop()
  await database.drop()
}
