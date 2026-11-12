import './identity-check'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'
import sharp from 'sharp'
import { WebSocket } from 'ws'
import { z } from 'zod'
import {
  AccessError,
  AccessStage,
  Account,
  Blocked,
  EventPage,
  Members,
  Room,
  Snapshot,
  type PublicUser,
} from '@huddle/contracts'
import {
  accountLink,
  Client,
  joinFriend,
  migratedDatabase,
  setupFriend,
  startServer,
  storedJoinCode,
  tailscale,
} from './harness'

type Result = Awaited<ReturnType<Client['call']>>
function failed(result: Result, status: number, error: AccessError['error'], label: string) {
  assert.equal(result.response.status, status, `${label}: ${JSON.stringify(result.value)}`)
  assert.equal(AccessError.parse(result.value).error, error, label)
}
function pass(message: string) {
  process.stdout.write(`PASS ${message}\n`)
}

const setupCode = `access-${randomUUID()}`
const database = await migratedDatabase()
const server = await startServer({
  databaseUrl: database.url,
  port: Number(process.env.TEST_PORT ?? 3200),
  entry: 'scripts/access-test-server.ts',
  env: { SETUP_CODE: setupCode },
}).catch(async (error: unknown) => {
  await database.drop()
  throw error
})
const base = server.origin
const sockets = new Set<WebSocket>()
async function eventually(predicate: () => boolean, message: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await delay(100)
  }
  assert.ok(predicate(), message)
}
try {
  const anonymous = new Client(base)
  assert.deepEqual(await anonymous.stage(), { kind: 'no-identity', reason: 'direct' })
  for (const path of [
    '/api/snapshot',
    '/api/members',
    '/api/invite',
    `/api/direct/messages?conversationId=${randomUUID()}`,
    '/api/account',
    `/api/account/photo/${randomUUID()}`,
  ])
    failed(await anonymous.call(path), 401, 'no_access', `anonymous ${path}`)
  failed(
    await anonymous.call('/api/access', {
      kind: 'account.setup',
      code: setupCode,
      serverName: 'Access server',
      name: 'Anonymous',
    }),
    401,
    'no_access',
    'setup with the right code but no identity',
  )
  const adminClient = new Client(base, 'access-admin@huddle.test')
  assert.deepEqual(await adminClient.stage(), {
    kind: 'setup',
    login: 'access-admin@huddle.test',
    suggestedName: 'access-admin',
  })
  failed(
    await adminClient.call('/api/access', {
      kind: 'account.setup',
      code: 'not-the-setup-code',
      serverName: 'Access server',
      name: 'Intruder',
    }),
    400,
    'invalid',
    'setup with a wrong code',
  )
  pass('without identity a visitor reads nothing and cannot set up; a person sees the setup stage')

  const admin = await setupFriend(adminClient, {
    code: setupCode,
    serverName: 'Access server',
    name: 'Synthetic member',
  })
  const ready = (user: PublicUser, login: string) => ({ kind: 'ready', login, user })
  assert.deepEqual(await adminClient.stage(), ready(admin, 'access-admin@huddle.test'))
  assert.deepEqual(
    Account.parse((await adminClient.call('/api/account')).value),
    { user: admin, login: 'access-admin@huddle.test' },
    'the account route tells a member their own login',
  )
  assert.equal(admin.avatar.kind, 'mascot')
  assert.equal(
    (await new Client(base, 'visitor@huddle.test').stage()).kind,
    'join',
    'setup is over for everyone else',
  )
  const noCookie = await fetch(`${base}/api/access`, {
    headers: tailscale('access-admin@huddle.test'),
  })
  assert.equal(noCookie.headers.getSetCookie().length, 0, 'identity needs no cookie')
  assert.equal(noCookie.headers.get('cache-control'), 'no-store')

  const code = await storedJoinCode(database.url)
  const friendClient = new Client(base, 'access-friend@huddle.test')
  const friend = await joinFriend(friendClient, code, 'Native member')
  const seat = Snapshot.parse((await adminClient.call('/api/snapshot')).value).server
  assert.equal(seat.role, 'admin')
  assert.equal(seat.memberCount, 2)
  assert.equal(
    (await new Client(base, 'Access-Friend@huddle.test').stage()).kind,
    'join',
    'a login is compared exactly, so another case is another person',
  )
  const encoded = await fetch(`${base}/api/access`, {
    headers: {
      'tailscale-user-login': 'jose@huddle.test',
      'tailscale-user-name': '=?utf-8?q?Jos=C3=A9_Garc=C3=ADa?=',
    },
  })
  assert.deepEqual(AccessStage.parse(await encoded.json()), {
    kind: 'join',
    login: 'jose@huddle.test',
    suggestedName: 'José García',
  })
  pass('setup makes the admin, a friend joins with the code, and each is recognized by exact login')

  const limited = new Client(base, 'access-limited@huddle.test')
  const attempt = (code: string) =>
    limited.call('/api/access', { kind: 'account.join', code, name: 'Limited' })
  for (let count = 0; count < 10; count++)
    failed(await attempt('not-a-real-join-code-xx'), 400, 'invalid', `wrong code ${count + 1}`)
  const throttled = await attempt(code)
  failed(throttled, 429, 'rate_limited', 'the eleventh attempt for one login')
  assert.ok(Date.parse(z.string().parse(AccessError.parse(throttled.value).retryAt)) > Date.now())
  assert.equal(
    (
      await new Client(base, 'access-other@huddle.test').call('/api/access', {
        kind: 'account.join',
        code: 'not-a-real-join-code-xx',
        name: 'Other',
      })
    ).response.status,
    400,
    'one login using up its attempts leaves another login alone',
  )
  failed(
    await anonymous.call('/api/access', {
      kind: 'account.join',
      code,
      name: 'Anonymous',
    }),
    401,
    'no_access',
    'no identity fails before any code is compared',
  )
  pass('ten setup or join attempts per login per window, then even the right code waits')

  for (const path of ['/api/members/link', '/api/members/logins', '/api/auth/sign-in/email'])
    assert.equal((await adminClient.call(path, {})).response.status, 404, `${path} does not exist`)
  const room = Room.parse((await adminClient.call('/api/rooms', { name: 'Lounge' })).value)
  const roster = await friendClient.call('/api/members')
  assert.deepEqual(
    Members.parse(roster.value).members.map(({ id, name, role }) => ({ id, name, role })),
    [
      { id: admin.id, name: 'Synthetic member', role: 'admin' },
      { id: friend.id, name: 'Native member', role: 'member' },
    ],
  )
  const exposed = (value: unknown) => JSON.stringify(value).includes('@huddle.test')
  assert.equal(exposed(roster.value), false, "a roster carries nobody's login")
  assert.equal(
    exposed((await adminClient.call('/api/members')).value),
    false,
    "an admin's roster carries no logins either",
  )
  assert.equal(exposed((await friendClient.call('/api/snapshot')).value), false)
  const socket = new WebSocket(server.websocket, {
    origin: base,
    headers: tailscale('access-friend@huddle.test'),
  })
  sockets.add(socket)
  const frames: string[] = []
  socket.on('error', () => {})
  socket.on('open', () => socket.send(JSON.stringify({ kind: 'watch', after: '0' })))
  socket.on('message', (data) => frames.push(data.toString()))
  await eventually(
    () =>
      frames.some((frame) =>
        EventPage.parse(JSON.parse(frame)).events.some(
          (event) => event.kind === 'room.created' && event.room.id === room.id,
        ),
      ),
    'the friend receives the room event',
  )
  assert.equal(exposed(frames), false, 'no event carries a login')
  socket.terminate()
  pass("members never see each other's logins, and no web route can bind one")

  const legacyId = 'legacy-account-id'
  const fixture = new pg.Client({ connectionString: database.url })
  await fixture.connect()
  try {
    await fixture.query(
      `INSERT INTO "user"(id, name, legacy_username) VALUES ($1, $2, 'waitingfriend')`,
      [legacyId, 'Waiting\nforged row\u001b[2K'],
    )
    await fixture.query('INSERT INTO account_security(user_id) VALUES ($1)', [legacyId])
    await fixture.query(`INSERT INTO member(user_id, role) VALUES ($1, 'member')`, [legacyId])
  } finally {
    await fixture.end()
  }
  const waiting = new Client(base, 'waiting@huddle.test')
  assert.equal((await waiting.stage()).kind, 'join', 'an unlinked account authenticates nobody')
  failed(await waiting.call('/api/snapshot'), 401, 'no_access', 'an unlinked account reads nothing')
  const forged = await accountLink(database.url)
  assert.doesNotMatch(forged.stdout, /^forged row/m, 'a stored newline cannot start a table row')
  assert.equal(
    forged.stdout.includes('\u001b'),
    false,
    'a stored escape never reaches the terminal',
  )
  const linked = await accountLink(database.url, 'waitingfriend', 'waiting@huddle.test')
  assert.equal(linked.code, 0, linked.stderr)
  assert.equal(linked.stdout.includes('\u001b'), false, 'nor does the link report print one')
  const back = await waiting.stage()
  assert.equal(back.kind === 'ready' && back.user.id, legacyId, 'the old account is back')
  pass('an unlinked account authenticates nobody until the host binds it from the command line')

  failed(
    await adminClient.call('/api/access', {
      kind: 'profile.save',
      profile: { name: 'Bob\nforged row', avatar: admin.avatar },
    }),
    400,
    'invalid',
    'a display name cannot hold a control character',
  )
  failed(
    await new Client(base, 'access-admin@huddle.test').call('/api/access', {
      kind: 'profile.save',
      profile: { name: 'Stale page', avatar: admin.avatar },
    }),
    401,
    'no_access',
    'saving a profile must name the account the page expects',
  )
  const unchanged = await adminClient.stage()
  assert.notEqual(
    unchanged.kind === 'ready' && unchanged.user.name,
    'Stale page',
    'a save without the account header changes nothing',
  )
  failed(
    await new Client(base, 'visitor@huddle.test').call('/api/access', {
      kind: 'profile.save',
      profile: { name: 'Visitor', avatar: admin.avatar },
    }),
    401,
    'no_access',
    'only a member saves a profile',
  )
  const photo = await sharp({
    create: { width: 32, height: 32, channels: 3, background: '#346bf1' },
  })
    .png()
    .toBuffer()
  const form = new FormData()
  form.set('photo', new File([new Uint8Array(photo)], 'avatar.png', { type: 'image/png' }))
  const adminHeaders = { Origin: base, ...tailscale('access-admin@huddle.test') }
  const upload = await fetch(`${base}/api/account/photo`, {
    method: 'POST',
    headers: { ...adminHeaders, 'X-Huddle-User': admin.id },
    body: form,
  })
  assert.equal(upload.status, 200)
  const uploaded = z.object({ uploadId: z.string() }).parse(await upload.json())
  const saved = await adminClient.act({
    kind: 'profile.save',
    profile: { name: 'Photo member', avatar: { kind: 'photo', uploadId: uploaded.uploadId } },
  })
  assert.equal(saved.kind === 'ready' && saved.user.name, 'Photo member')
  const image = await fetch(`${base}/api/account/photo/${uploaded.uploadId}`, {
    headers: adminHeaders,
  })
  assert.equal(image.status, 200)
  assert.equal((await sharp(Buffer.from(await image.arrayBuffer())).metadata()).format, 'webp')
  assert.equal(
    (await friendClient.call(`/api/account/photo/${uploaded.uploadId}`)).response.ok,
    true,
  )
  assert.equal(
    (await new Client(base).call(`/api/account/photo/${uploaded.uploadId}`)).response.ok,
    false,
  )
  failed(
    await friendClient.call('/api/access', {
      kind: 'profile.save',
      profile: { name: 'Borrowed photo', avatar: { kind: 'photo', uploadId: uploaded.uploadId } },
    }),
    400,
    'invalid',
    "another member's photo",
  )
  const invalidForm = new FormData()
  invalidForm.set(
    'photo',
    new File(['<svg><script>bad()</script></svg>'], 'avatar.svg', { type: 'image/svg+xml' }),
  )
  assert.equal(
    (
      await fetch(`${base}/api/account/photo`, {
        method: 'POST',
        headers: { ...adminHeaders, 'X-Huddle-User': admin.id },
        body: invalidForm,
      })
    ).ok,
    false,
  )
  const unnamed = await fetch(`${base}/api/account/photo`, {
    method: 'POST',
    headers: adminHeaders,
    body: form,
  })
  assert.equal(unnamed.status, 401, 'an upload must name its account')
  pass(
    'photo decode and re-encode, persisted profile, visibility to fellow members but not anonymous callers, and active SVG rejection',
  )

  const leaving = new Client(base, 'access-leaving@huddle.test')
  const left = await joinFriend(leaving, code, 'Leaving member')
  const watching = new WebSocket(server.websocket, {
    origin: base,
    headers: tailscale('access-friend@huddle.test'),
  })
  sockets.add(watching)
  const removalFrames: string[] = []
  watching.on('error', () => {})
  watching.on('open', () => watching.send(JSON.stringify({ kind: 'watch', after: '0' })))
  watching.on('message', (data) => removalFrames.push(data.toString()))
  await eventually(() => removalFrames.length > 0, 'the friend watches')
  const remove = (userId: string) => adminClient.call('/api/members/remove', { userId })
  const unblock = (userId: string) => adminClient.call('/api/members/unblock', { userId })
  assert.equal((await remove(left.id)).response.status, 200)
  const removedStage = { kind: 'removed', login: 'access-leaving@huddle.test' }
  assert.deepEqual(await leaving.stage(), removedStage)
  for (const path of ['/api/snapshot', '/api/members', '/api/account'])
    failed(await leaving.call(path), 401, 'no_access', `a removed member reads ${path}`)
  for (let count = 0; count < 12; count++)
    assert.deepEqual(
      await leaving.act({ kind: 'account.join', code, name: 'Leaving member' }),
      removedStage,
      `join ${count + 1} keeps a removed person out`,
    )
  failed(
    await leaving.call('/api/access', {
      kind: 'profile.save',
      profile: { name: 'Still here', avatar: admin.avatar },
    }),
    401,
    'no_access',
    'a removed person saves no profile',
  )
  await eventually(
    () =>
      removalFrames.some((frame) =>
        EventPage.parse(JSON.parse(frame)).events.some(
          (event) => event.kind === 'member.removed' && event.userId === left.id,
        ),
      ),
    'the friend hears member.removed',
  )
  assert.equal(exposed(removalFrames), false, 'member.removed carries no login')
  const blockedList = await adminClient.call('/api/blocked')
  assert.deepEqual(
    Blocked.parse(blockedList.value).blocked.map(({ id, name }) => ({ id, name })),
    [{ id: left.id, name: 'Leaving member' }],
  )
  assert.equal(exposed(blockedList.value), false, 'the Blocked list carries no login')
  assert.equal((await unblock(left.id)).response.status, 200)
  assert.equal((await leaving.stage()).kind, 'join')
  assert.equal(
    (await joinFriend(leaving, code, 'Leaving member')).id,
    left.id,
    'joining after the block lifts is not rate limited by the refused joins',
  )
  pass(
    'a removed member sees the removed stage, reads nothing, cannot rejoin or spend join attempts, and no admin view or frame carries their login',
  )

  const encodedLogin = { 'tailscale-user-login': '=?utf-8?q?j=C3=B6rg@huddle.test?=' }
  const asJorg = async (body?: unknown) => {
    const response = await fetch(`${base}/api/access`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json', ...encodedLogin },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    assert.equal(response.status, 200)
    return AccessStage.parse(await response.json())
  }
  const jorg = await asJorg({ kind: 'account.join', code, name: 'Jörg' })
  assert.equal(jorg.kind, 'ready')
  assert.equal((await remove(jorg.user.id)).response.status, 200)
  assert.deepEqual(await asJorg(), { kind: 'removed', login: 'jörg@huddle.test' })
  assert.deepEqual(await asJorg({ kind: 'account.join', code, name: 'Jörg' }), {
    kind: 'removed',
    login: 'jörg@huddle.test',
  })
  assert.equal((await unblock(jorg.user.id)).response.status, 200)
  assert.equal((await asJorg({ kind: 'account.join', code, name: 'Jörg' })).kind, 'ready')
  pass('removal and the block apply the same way to a Q-encoded non-ASCII login')

  const unlinkedId = 'unlinked-removal-id'
  const seed = new pg.Client({ connectionString: database.url })
  await seed.connect()
  try {
    await seed.query(
      `INSERT INTO "user"(id, name, legacy_username) VALUES ($1, 'Unlinked', 'unlinkedfriend')`,
      [unlinkedId],
    )
    await seed.query('INSERT INTO account_security(user_id) VALUES ($1)', [unlinkedId])
    await seed.query(`INSERT INTO member(user_id, role) VALUES ($1, 'member')`, [unlinkedId])
    assert.equal((await remove(unlinkedId)).response.status, 200)
    assert.equal(
      (await seed.query('SELECT 1 FROM blocked_account WHERE user_id = $1', [unlinkedId])).rowCount,
      1,
      'removing an account with no login still blocks it',
    )
  } finally {
    await seed.end()
  }
  const relinked = await accountLink(database.url, 'unlinkedfriend', 'unlinked@huddle.test')
  assert.equal(relinked.code, 1, 'account:link cannot point a login at a removed account')
  assert.equal((await new Client(base, 'unlinked@huddle.test').stage()).kind, 'join')
  pass('an unlinked account can be removed, and account:link refuses to revive it')
} catch (error) {
  process.stderr.write(server.logs())
  throw error
} finally {
  for (const socket of sockets) socket.terminate()
  await server.stop()
  await database.drop()
}
