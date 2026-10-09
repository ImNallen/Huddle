import assert from 'node:assert/strict'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { z } from 'zod'
import {
  AccessView,
  AccountSecurity,
  DeviceCode,
  DeviceToken,
  Snapshot,
  type AccessStage,
} from '@huddle/contracts'
import {
  Client,
  emailCode,
  invite,
  mailIds,
  migratedDatabase,
  nextMail,
  onboard,
  sendCode,
  startServer,
  syntheticEmail,
  totpNow,
  type ServerProcess,
} from './harness'

type Result = Awaited<ReturnType<Client['call']>>
type Stage<K extends AccessStage['kind']> = Extract<AccessStage, { kind: K }>
const isStage = <K extends AccessStage['kind']>(stage: AccessStage, kind: K): stage is Stage<K> =>
  stage.kind === kind
function requireStage<K extends AccessStage['kind']>(result: Result, kind: K) {
  assert.equal(result.response.status, 200, `expected ${kind}: ${JSON.stringify(result.value)}`)
  const { stage } = AccessView.parse(result.value)
  assert(isStage(stage, kind), `expected ${kind}, received stage ${stage.kind}`)
  return stage
}
function denied(result: Result, label: string) {
  const { status } = result.response
  assert.ok([401, 403, 404].includes(status), `${label} unexpectedly returned status ${status}`)
}
function blocked(result: Result, label: string) {
  const { status } = result.response
  assert.ok(status >= 400, `${label} unexpectedly returned status ${status}`)
}
function pass(message: string) {
  process.stdout.write(`PASS ${message}\n`)
}

const setupCode = `probe-${randomUUID()}`
const email = syntheticEmail('probe')
const database = await migratedDatabase()
let server: ServerProcess | undefined
const sockets = new Set<WebSocket>()

async function sendAndVerify(client: Client, address: string) {
  const seen = await mailIds(address)
  await sendCode(client, address)
  requireStage(await client.call('/api/access'), 'email')
  denied(await client.call('/api/snapshot'), 'unverified email server read')
  denied(await client.call('/api/account'), 'unverified email account read')
  return client.call('/api/access', {
    kind: 'email.verify',
    code: await emailCode(address, seen),
  })
}

async function anonymous(origin: string) {
  const client = new Client(origin)
  assert.deepEqual(
    requireStage(await client.call('/api/access'), 'setup').methods,
    ['email'],
    'a server that is not set up offers email onboarding',
  )
  for (const path of ['/api/snapshot', '/api/home', '/api/account'])
    denied(await client.call(path), `anonymous ${path}`)
  for (const [path, body] of [
    ['/api/auth/sign-in/email', { email, password: 'synthetic-password-only' }],
    ['/api/auth/sign-up/email', { name: 'Probe', email, password: 'synthetic-password-only' }],
    ['/api/auth/request-password-reset', { email }],
    ['/api/auth/reset-password', { newPassword: 'synthetic-password-only', token: 'invalid' }],
  ] as const)
    blocked(await client.call(path, body), `blocked password route ${path}`)
  blocked(
    await client.call('/api/auth/device/approve', { userCode: 'INVALID' }),
    'anonymous device approval',
  )
  pass('anonymous protected APIs, password routes, and device approval deny access')
}

async function setup(origin: string) {
  const wrong = await new Client(origin).call('/api/access', {
    kind: 'setup.start',
    code: 'not-the-setup-code',
    serverName: 'Probe',
    email: syntheticEmail('admin'),
  })
  blocked(wrong, 'setup with a wrong code')
  const admin = new Client(origin)
  await onboard(admin, { code: setupCode, serverName: 'Probe' })
  const anonymousStage = requireStage(await new Client(origin).call('/api/access'), 'signin')
  assert.deepEqual(anonymousStage.methods, ['email', 'passkey'])
  const stranger = new Client(origin)
  const strangerEmail = syntheticEmail('stranger')
  const seen = await mailIds(strangerEmail)
  requireStage(
    await stranger.call('/api/access', { kind: 'email.send', email: strangerEmail }),
    'email',
  )
  const notice = await nextMail(strangerEmail, seen)
  assert.match(notice.text, /no account for it on this server/)
  assert.doesNotMatch(notice.text, /\b\d{6}\b/, 'the no-account email carries no code')
  blocked(
    await stranger.call('/api/access', { kind: 'email.verify', code: '000000' }),
    'an uninvited email verification',
  )
  denied(await stranger.call('/api/snapshot'), 'uninvited email server read')
  pass(
    'setup code onboarding creates the admin; an uninvited email gets a no-account notice and no access',
  )
  return admin
}

async function enrollProbe(origin: string, admin: Client) {
  await invite(admin, email)
  const client = new Client(origin)
  const enrollment = requireStage(await sendAndVerify(client, email), 'enroll')
  denied(await client.call('/api/snapshot'), 'email-only server read')
  const correct = totpNow(enrollment.secret)
  const incorrect = String((Number(correct) + 1) % 1_000_000).padStart(6, '0')
  blocked(
    await client.call('/api/access', {
      kind: 'enrollment.verify',
      generation: enrollment.generation,
      code: incorrect,
    }),
    'incorrect authenticator proof',
  )
  const verified = requireStage(
    await client.call('/api/access', {
      kind: 'enrollment.verify',
      generation: enrollment.generation,
      code: correct,
    }),
    'save-recovery',
  )
  assert.ok(verified.codes.length > 0, 'recovery codes are returned')
  denied(await client.call('/api/snapshot'), 'unacknowledged recovery server read')
  requireStage(
    await client.call('/api/access', { kind: 'recovery.ack', batch: verified.batch }),
    'passkey-offer',
  )
  requireStage(await client.call('/api/access', { kind: 'passkey.skip' }), 'profile')
  const ready = requireStage(
    await client.call('/api/access', {
      kind: 'profile.save',
      profile: { name: 'Probe User', avatar: { kind: 'mascot', shape: 'circle', color: 'indigo' } },
    }),
    'ready',
  )
  assert.equal(ready.user.email, email)
  const snapshot = await client.call('/api/snapshot')
  assert.equal(snapshot.response.status, 200)
  assert.equal(Snapshot.parse(snapshot.value).server.role, 'member')
  const account = await client.call('/api/account')
  assert.equal(account.response.status, 200)
  const inventory = AccountSecurity.parse(account.value)
  assert.ok(inventory.authenticator?.enrolledAt)
  assert.equal(inventory.recoveryRemaining, verified.codes.length)
  pass(
    'invited SMTP email, actual TOTP enrollment, recovery acknowledgement, profile, server admission, account inventory',
  )
  return { client, secret: enrollment.secret, recoveryCodes: verified.codes, userId: ready.user.id }
}

async function deviceAndSocket(
  origin: string,
  websocket: string,
  enrolled: Awaited<ReturnType<typeof enrollProbe>>,
) {
  const device = await new Client(origin).call('/api/auth/device/code', {
    client_id: 'huddle-desktop',
  })
  assert.equal(device.response.status, 200, `device grant: ${JSON.stringify(device.value)}`)
  const code = DeviceCode.parse(device.value)
  const body = {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: code.device_code,
    client_id: 'huddle-desktop',
  }
  const native = new Client(origin)
  const pending = await native.call('/api/auth/device/token', body)
  assert.equal(z.object({ error: z.string() }).parse(pending.value).error, 'authorization_pending')
  const claim = await enrolled.client.call(
    `/api/auth/device?user_code=${encodeURIComponent(code.user_code)}`,
  )
  assert.equal(claim.response.status, 200, JSON.stringify(claim.value))
  requireStage(
    await enrolled.client.call('/api/access', {
      kind: 'device.decide',
      userCode: code.user_code,
      decision: 'approve',
    }),
    'ready',
  )
  await delay((code.interval + 1) * 1000)
  const exchanged = await native.call('/api/auth/device/token', body)
  assert.equal(exchanged.response.status, 200, JSON.stringify(exchanged.value))
  const bearer = new Client(origin)
  bearer.token = DeviceToken.parse(exchanged.value).access_token
  assert.equal(
    requireStage(await bearer.call('/api/access'), 'ready').user.id,
    enrolled.userId,
    'the approved native bearer belongs to the approving user',
  )
  const ticket = await enrolled.client.call('/api/watch-ticket', {})
  assert.equal(ticket.response.status, 200)
  const socket = new WebSocket(websocket, { origin })
  sockets.add(socket)
  socket.on('error', () => {})
  await once(socket, 'open')
  const closed = once(socket, 'close')
  const firstFrame = once(socket, 'message')
  socket.send(
    JSON.stringify({
      kind: 'watch',
      after: '0',
      ticket: z.object({ ticket: z.string() }).parse(ticket.value).ticket,
    }),
  )
  await Promise.race([
    firstFrame,
    closed.then(() => assert.fail('watch closed before first event')),
    delay(5000).then(() => assert.fail('watch did not establish')),
  ])
  await delay((30 - (Math.floor(Date.now() / 1000) % 30)) * 1000 + 1500)
  const batch = requireStage(
    await enrolled.client.call('/api/access', {
      kind: 'security.commit',
      change: { kind: 'recovery.regenerate' },
      proof: { kind: 'totp', code: totpNow(enrolled.secret) },
    }),
    'save-recovery',
  )
  assert.ok(batch.codes.length > 0)
  requireStage(
    await enrolled.client.call('/api/access', { kind: 'recovery.ack', batch: batch.batch }),
    'ready',
  )
  denied(await bearer.call('/api/snapshot'), 'stale native bearer after factor change')
  await Promise.race([
    closed,
    delay(5000).then(() => assert.fail('watch remained open after factor change')),
  ])
  pass(
    'explicit device approval, native bearer, fresh factor change, epoch revocation, socket closure',
  )
  return batch.codes
}

async function concurrentTotp(origin: string, secret: string) {
  const first = new Client(origin)
  const second = new Client(origin)
  requireStage(await sendAndVerify(first, email), 'totp')
  requireStage(await sendAndVerify(second, email), 'totp')
  const code = totpNow(secret)
  const results = await Promise.all(
    [first, second].map((client) => client.call('/api/access', { kind: 'totp.verify', code })),
  )
  const statuses = results.map((result) => result.response.status)
  assert.equal(statuses.filter((status) => status === 200).length, 1, 'one session accepts a step')
  assert.equal(statuses.filter((status) => status >= 400).length, 1, 'the replay is refused')
  pass('concurrent TOTP replay accepts one session')
}

async function concurrentRecovery(origin: string, previous: Client, recoveryCodes: string[]) {
  const first = new Client(origin)
  const second = new Client(origin)
  requireStage(await sendAndVerify(first, email), 'totp')
  requireStage(await sendAndVerify(second, email), 'totp')
  requireStage(await first.call('/api/access', { kind: 'recovery.choose' }), 'recovery')
  requireStage(await second.call('/api/access', { kind: 'recovery.choose' }), 'recovery')
  const code = z.string().parse(recoveryCodes[0])
  const prepared = await Promise.all(
    [first, second].map(async (client) =>
      requireStage(await client.call('/api/access', { kind: 'recovery.verify', code }), 'enroll'),
    ),
  )
  denied(await first.call('/api/snapshot'), 'prepared recovery replacement server read')
  denied(await second.call('/api/account'), 'prepared recovery replacement account read')
  const installed = await Promise.all(
    [first, second].map((client, index) => {
      const stage = prepared[index]
      assert(stage)
      return client.call('/api/access', {
        kind: 'enrollment.verify',
        generation: stage.generation,
        code: totpNow(stage.secret),
      })
    }),
  )
  const winner = installed.findIndex((result) => result.response.status === 200)
  assert.equal(
    installed.filter((result) => result.response.status === 200).length,
    1,
    'recovery replacement commits once',
  )
  assert.equal(installed.filter((result) => result.response.status >= 400).length, 1)
  const committed = installed[winner]
  const owner = [first, second][winner]
  assert(committed && owner)
  const saved = requireStage(committed, 'save-recovery')
  assert.ok(saved.codes.length > 0)
  requireStage(
    await owner.call('/api/access', { kind: 'recovery.ack', batch: saved.batch }),
    'ready',
  )
  denied(await previous.call('/api/snapshot'), 'old browser session after recovery replacement')
  blocked(
    await second.call('/api/access', { kind: 'recovery.verify', code }),
    'consumed recovery code replay',
  )
  pass(
    'concurrent recovery preparation has no authority; one atomic replacement, epoch invalidation, consumed-code replay',
  )
}

try {
  server = await startServer({
    databaseUrl: database.url,
    port: 3300,
    entry: 'scripts/access-test-server.ts',
    env: { SETUP_CODE: setupCode },
  })
  await anonymous(server.origin)
  const admin = await setup(server.origin)
  const enrolled = await enrollProbe(server.origin, admin)
  const recoveryCodes = await deviceAndSocket(server.origin, server.websocket, enrolled)
  await concurrentTotp(server.origin, enrolled.secret)
  await concurrentRecovery(server.origin, enrolled.client, recoveryCodes)
} finally {
  for (const socket of sockets) socket.terminate()
  await server?.stop()
  await database.drop()
}
