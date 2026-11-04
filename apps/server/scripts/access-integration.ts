import assert from 'node:assert/strict'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import sharp from 'sharp'
import { WebSocket } from 'ws'
import { z } from 'zod'
import { AccessError, AccessView, AccountSecurity, Snapshot } from '@huddle/contracts'
import {
  Client,
  joinFriend,
  migratedDatabase,
  setupFriend,
  startServer,
  storedJoinCode,
} from './harness'

type Result = Awaited<ReturnType<Client['call']>>
function failed(result: Result, status: number, error: AccessError['error'], label: string) {
  assert.equal(result.response.status, status, `${label}: ${JSON.stringify(result.value)}`)
  assert.equal(AccessError.parse(result.value).error, error, label)
}
function stage(result: Result) {
  assert.equal(result.response.status, 200, JSON.stringify(result.value))
  return AccessView.parse(result.value).stage
}
function pass(message: string) {
  process.stdout.write(`PASS ${message}\n`)
}

async function watchTicket(client: Client) {
  return z.object({ ticket: z.string() }).parse((await client.call('/api/watch-ticket', {})).value)
    .ticket
}
async function currentSession(client: Client) {
  const session = AccountSecurity.parse((await client.call('/api/account')).value).sessions.find(
    (item) => item.current,
  )
  assert(session)
  return session.id
}
type Watch = { socket: WebSocket; closed: Promise<unknown> }
async function watchFrame(ticket: string) {
  const socket = new WebSocket(server.websocket, { origin: base })
  sockets.add(socket)
  socket.on('error', () => {})
  const closed = once(socket, 'close')
  await once(socket, 'open')
  const page = once(socket, 'message').then(() => 'page' as const)
  socket.send(JSON.stringify({ kind: 'watch', after: '0', ticket }))
  return { socket, closed, page }
}
async function watching(client: Client): Promise<Watch> {
  const watch = await watchFrame(await watchTicket(client))
  await Promise.race([
    watch.page,
    watch.closed.then(() => assert.fail('watch closed before its first page')),
    delay(5000).then(() => assert.fail('watch did not start')),
  ])
  return watch
}
async function cutOff(client: Client, live: Watch, ticket: string, label: string) {
  failed(await client.call('/api/snapshot'), 401, 'reauth_required', label)
  await Promise.race([
    live.closed,
    delay(5000).then(() => assert.fail(`${label}: watch stayed open`)),
  ])
  const unused = await watchFrame(ticket)
  const [code] = z
    .tuple([z.number(), z.unknown()])
    .parse(await Promise.race([unused.closed, unused.page]))
  assert.equal(code, 1008, `${label}: its unused ticket fails`)
}
async function stillLive(client: Client, live: Watch | undefined, label: string) {
  assert.equal((await client.call('/api/snapshot')).response.status, 200, label)
  if (!live) return
  await delay(2500)
  assert.equal(live.socket.readyState, WebSocket.OPEN, `${label}: watch stays open`)
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
try {
  const anonymous = new Client(base)
  assert.deepEqual(stage(await anonymous.call('/api/access')), { kind: 'setup' })
  for (const path of [
    '/api/snapshot',
    '/api/members',
    `/api/direct/messages?conversationId=${randomUUID()}`,
    '/api/account',
  ])
    failed(await anonymous.call(path), 401, 'reauth_required', `anonymous ${path}`)
  for (const path of [
    '/sign-in/email',
    '/sign-up/email',
    '/sign-in/social',
    '/request-password-reset',
    '/reset-password',
    '/get-session',
    '/huddle/response',
  ])
    failed(await anonymous.call(`/api/auth${path}`, {}), 400, 'invalid', `raw Better Auth ${path}`)
  failed(
    await anonymous.call('/api/access', {
      kind: 'account.setup',
      code: 'not-the-setup-code',
      serverName: 'Access server',
      username: 'intruder',
      password: 'intruder-secret',
    }),
    400,
    'invalid',
    'setup with a wrong code',
  )
  pass('anonymous callers see setup, cannot read the server, and reach no raw Better Auth route')

  const browser = new Client(base)
  const adminPassword = 'access-admin-secret'
  await setupFriend(browser, {
    code: setupCode,
    serverName: 'Access server',
    username: 'access-admin',
    password: adminPassword,
    name: 'Synthetic member',
  })
  assert(browser.cookies.size > 0)
  assert.equal(browser.token, '')
  assert.deepEqual(stage(await new Client(base).call('/api/access')), { kind: 'signin' })
  const native = new Client(base, true)
  const memberPassword = 'access-member-secret'
  await joinFriend(
    native,
    await storedJoinCode(database.url),
    'access-member',
    memberPassword,
    'Native member',
  )
  assert(native.token.length > 0)
  assert.equal(native.cookies.size, 0)
  for (const client of [browser, native]) {
    const inventory = AccountSecurity.parse((await client.call('/api/account')).value)
    assert.equal(inventory.user.avatar.kind, 'mascot')
    assert.deepEqual(
      inventory.sessions.map((session) => session.current),
      [true],
    )
  }
  const seat = Snapshot.parse((await browser.call('/api/snapshot')).value).server
  assert.equal(seat.role, 'admin')
  assert.equal(seat.memberCount, 2)
  failed(
    await new Client(base).call('/api/access', {
      kind: 'account.signin',
      username: 'access-stranger',
      password: 'access-stranger-secret',
    }),
    400,
    'invalid',
    'an unknown username',
  )
  failed(
    await new Client(base).call('/api/access', {
      kind: 'account.signin',
      username: 'access-member',
      password: 'access-wrong-secret',
    }),
    400,
    'invalid',
    'a wrong password',
  )
  pass(
    'setup gives the admin a cookie session, join gives a native bearer, and unknown users or wrong passwords get nothing',
  )

  const limited = new Client(base, true)
  await joinFriend(
    limited,
    await storedJoinCode(database.url),
    'access-limited',
    'access-limited-secret',
    'Limited member',
  )
  for (let attempt = 0; attempt < 10; attempt++)
    failed(
      await new Client(base).call('/api/access', {
        kind: 'account.signin',
        username: 'access-limited',
        password: 'access-wrong-secret',
      }),
      400,
      'invalid',
      `wrong password attempt ${attempt + 1}`,
    )
  const throttled = await new Client(base).call('/api/access', {
    kind: 'account.signin',
    username: 'access-limited',
    password: 'access-limited-secret',
  })
  failed(throttled, 429, 'rate_limited', 'the eleventh sign-in for one username')
  assert.ok(Date.parse(z.string().parse(AccessError.parse(throttled.value).retryAt)) > Date.now())
  assert.equal((await limited.call('/api/snapshot')).response.status, 200)
  pass('ten sign-ins per username per window, then even the right password waits until retryAt')

  const memberSignIn = {
    kind: 'account.signin',
    username: 'access-member',
    password: memberPassword,
  } as const
  const phone = new Client(base, true)
  await phone.act(memberSignIn)
  const laptop = new Client(base)
  await laptop.act(memberSignIn)
  const nativeToken = native.token
  const phoneLive = await watching(phone)
  const phoneTicket = await watchTicket(phone)
  const laptopLive = await watching(laptop)
  const phoneSession = await currentSession(phone)
  stage(await native.call('/api/access', { kind: 'session.revoke', id: phoneSession }))
  await cutOff(phone, phoneLive, phoneTicket, 'the revoked session')
  await stillLive(laptop, laptopLive, 'a session that was not revoked')
  await stillLive(native, undefined, 'the revoking session')
  assert.equal(native.token, nativeToken, 'the revoking session keeps its token')
  assert.deepEqual(
    AccountSecurity.parse((await native.call('/api/account')).value).sessions.map(
      (session) => session.current,
    ),
    [true, false],
  )
  pass('signing out one session ends its HTTP access, its watch and its tickets, and nothing else')

  const laptopSession = await currentSession(laptop)
  stage(await browser.call('/api/access', { kind: 'session.revoke', id: laptopSession }))
  await stillLive(laptop, laptopLive, 'a session another account tried to revoke')
  pass("a session cannot sign out another account's session")

  const tablet = new Client(base, true)
  await tablet.act(memberSignIn)
  const laptopTicket = await watchTicket(laptop)
  stage(await native.call('/api/access', { kind: 'sessions.revoke-others' }))
  await cutOff(laptop, laptopLive, laptopTicket, 'another session after sign out all others')
  failed(await tablet.call('/api/snapshot'), 401, 'reauth_required', 'the second other session')
  await stillLive(native, undefined, 'the session that signed out the others')
  assert.deepEqual(
    AccountSecurity.parse((await native.call('/api/account')).value).sessions.map(
      (session) => session.current,
    ),
    [true],
  )
  pass('signing out all other sessions ends every session but the current one')

  for (let attempt = 0; attempt < 5; attempt++)
    failed(
      await limited.call('/api/access', {
        kind: 'password.change',
        current: 'access-wrong-secret',
        next: 'access-limited-next',
      }),
      400,
      'invalid',
      `wrong current password attempt ${attempt + 1}`,
    )
  const passwordThrottled = await limited.call('/api/access', {
    kind: 'password.change',
    current: 'access-limited-secret',
    next: 'access-limited-next',
  })
  failed(passwordThrottled, 429, 'rate_limited', 'the sixth password change in a window')
  assert.ok(
    Date.parse(z.string().parse(AccessError.parse(passwordThrottled.value).retryAt)) > Date.now(),
  )
  assert.equal((await limited.call('/api/snapshot')).response.status, 200)
  pass('five password changes per account per window, then even the right password waits')

  const nextPassword = 'access-member-next-secret'
  const desktop = new Client(base, true)
  await desktop.act(memberSignIn)
  const desktopLive = await watching(desktop)
  const desktopTicket = await watchTicket(desktop)
  failed(
    await native.call('/api/access', {
      kind: 'password.change',
      current: 'not-the-member-secret',
      next: nextPassword,
    }),
    400,
    'invalid',
    'a wrong current password',
  )
  failed(
    await native.call('/api/access', {
      kind: 'password.change',
      current: memberPassword,
      next: 'short',
    }),
    400,
    'invalid',
    'a new password under eight characters',
  )
  await stillLive(desktop, desktopLive, 'a rejected password change ends nothing')
  assert.equal(
    stage(
      await native.call('/api/access', {
        kind: 'password.change',
        current: memberPassword,
        next: nextPassword,
      }),
    ).kind,
    'ready',
  )
  await stillLive(native, undefined, 'the session that changed the password')
  assert.equal(native.token, nativeToken, 'changing the password keeps the current token')
  await cutOff(desktop, desktopLive, desktopTicket, 'another session after a password change')
  failed(
    await new Client(base).call('/api/access', memberSignIn),
    400,
    'invalid',
    'the old password after a change',
  )
  assert.equal(
    (await new Client(base).act({ ...memberSignIn, password: nextPassword })).stage.kind,
    'ready',
  )
  pass(
    'a password change needs the current password, keeps this session, ends the others, and only the new password signs in',
  )

  const photo = await sharp({
    create: { width: 32, height: 32, channels: 3, background: '#346bf1' },
  })
    .png()
    .toBuffer()
  const form = new FormData()
  form.set('photo', new File([new Uint8Array(photo)], 'avatar.png', { type: 'image/png' }))
  const upload = await fetch(`${base}/api/account/photo`, {
    method: 'POST',
    headers: { Origin: base, Cookie: browser.cookie() },
    body: form,
  })
  assert.equal(upload.status, 200)
  const uploaded = z.object({ uploadId: z.string() }).parse(await upload.json())
  const saved = await browser.act({
    kind: 'profile.save',
    profile: { name: 'Photo member', avatar: { kind: 'photo', uploadId: uploaded.uploadId } },
  })
  assert.equal(saved.stage.kind === 'ready' && saved.stage.user.name, 'Photo member')
  const image = await fetch(`${base}/api/account/photo/${uploaded.uploadId}`, {
    headers: { Cookie: browser.cookie() },
  })
  assert.equal(image.status, 200)
  assert.equal((await sharp(Buffer.from(await image.arrayBuffer())).metadata()).format, 'webp')
  assert.equal((await native.call(`/api/account/photo/${uploaded.uploadId}`)).response.ok, true)
  assert.equal(
    (await new Client(base).call(`/api/account/photo/${uploaded.uploadId}`)).response.ok,
    false,
  )
  failed(
    await native.call('/api/access', {
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
        headers: { Origin: base, Cookie: browser.cookie() },
        body: invalidForm,
      })
    ).ok,
    false,
  )
  pass(
    'photo decode and re-encode, persisted profile, visibility to fellow members but not anonymous callers, and active SVG rejection',
  )

  assert.deepEqual(stage(await browser.call('/api/access', { kind: 'signout' })), {
    kind: 'signin',
  })
  failed(await browser.call('/api/snapshot'), 401, 'reauth_required', 'a signed-out cookie')
  pass('sign-out ends the session and returns to sign-in')
} catch (error) {
  process.stderr.write(server.logs())
  throw error
} finally {
  for (const socket of sockets) socket.terminate()
  await server.stop()
  await database.drop()
}
