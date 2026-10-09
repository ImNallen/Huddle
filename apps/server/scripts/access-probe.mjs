import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const base = process.env.HUDDLE_PROBE_URL ?? 'http://localhost:3000'
const mailpit = process.env.HUDDLE_MAILPIT_URL ?? 'http://localhost:8025'
const email = process.env.HUDDLE_PROBE_EMAIL ?? `probe-${Date.now()}@huddle.test`
const statePath =
  process.env.HUDDLE_PROBE_STATE ??
  join(tmpdir(), `huddle-access-probe-${randomBytes(8).toString('hex')}.json`)
const origin = new URL(base).origin
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class Client {
  cookies = new Map()
  async request(path, body, method = body === undefined ? 'GET' : 'POST') {
    const headers = { origin }
    if (this.cookies.size)
      headers.cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
    if (body !== undefined) headers['content-type'] = 'application/json'
    const response = await fetch(new URL(path, base), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    })
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';', 1)[0]
      const index = pair.indexOf('=')
      if (index < 0) continue
      if (!pair.slice(index + 1)) this.cookies.delete(pair.slice(0, index))
      else this.cookies.set(pair.slice(0, index), pair.slice(index + 1))
    }
    const text = await response.text()
    let data
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = text
    }
    return { status: response.status, data, headers: response.headers }
  }
  async action(command) {
    return this.request('/api/access', command)
  }
  async view() {
    return this.request('/api/access')
  }
}
function requireStage(result, kind) {
  assert.equal(result.status, 200, `expected ${kind}, received status ${result.status}`)
  assert.equal(
    result.data?.stage?.kind,
    kind,
    `expected ${kind}, received stage ${result.data?.stage?.kind ?? 'none'}`,
  )
  return result.data
}
function denied(result, label) {
  assert.ok(
    result.status === 401 || result.status === 403 || result.status === 404,
    `${label} unexpectedly returned status ${result.status}`,
  )
}
function blocked(result, label) {
  assert.ok(result.status >= 400, `${label} unexpectedly returned status ${result.status}`)
}
function mailIds(messages) {
  return new Set(messages.messages.map((message) => message.ID))
}
async function inbox() {
  const response = await fetch(`${mailpit}/api/v1/messages`)
  assert.equal(response.status, 200, 'Mailpit unavailable')
  return response.json()
}
async function latestEmailCode(before) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const messages = (await inbox()).messages
    const match = messages.find(
      (message) =>
        !before.has(message.ID) &&
        message.To?.some((recipient) => recipient.Address?.toLowerCase() === email.toLowerCase()),
    )
    if (match) {
      const response = await fetch(`${mailpit}/api/v1/message/${encodeURIComponent(match.ID)}`)
      assert.equal(response.status, 200)
      const message = await response.json()
      const found = message.Text?.match(/(?:^|\r?\n)(\d{6})(?:\r?\n|$)/)
      assert.ok(
        found,
        'Mailpit delivered a message without the expected six-digit authentication code',
      )
      return found[1]
    }
    await wait(200)
  }
  throw new Error('Mailpit did not receive the authentication email')
}
function totp(uri, offset = 0) {
  const parsed = new URL(uri)
  assert.equal(parsed.protocol, 'otpauth:')
  const secret = parsed.searchParams.get('secret')
  const period = Number(parsed.searchParams.get('period') ?? 30)
  const digits = Number(parsed.searchParams.get('digits') ?? 6)
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let value = 0
  const bytes = []
  for (const letter of secret.toUpperCase().replaceAll('=', '')) {
    value = (value << 5) | alphabet.indexOf(letter)
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((value >> bits) & 255)
    }
  }
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / period) + offset))
  const digest = createHmac('sha1', Buffer.from(bytes)).update(counter).digest()
  const index = digest.at(-1) & 15
  return String((digest.readUInt32BE(index) & 0x7fffffff) % 10 ** digits).padStart(digits, '0')
}
async function sendAndVerify(client, address) {
  const before = mailIds(await inbox())
  let sent = await client.action({ kind: 'email.send', email: address })
  if (sent.status === 429 && sent.data?.retryAt) {
    await wait(Math.max(0, Date.parse(sent.data.retryAt) - Date.now()) + 250)
    sent = await client.action({ kind: 'email.send', email: address })
  }
  requireStage(sent, 'email')
  denied(await client.request('/api/workspaces'), 'unverified email workspace read')
  denied(await client.request('/api/account'), 'unverified email account read')
  const code = await latestEmailCode(before)
  return client.action({ kind: 'email.verify', code })
}
async function anonymous() {
  if (process.env.HUDDLE_LEGACY_SESSION_TOKEN) {
    for (const path of ['/api/workspaces', '/api/account', '/api/watch-ticket']) {
      const response = await fetch(new URL(path, base), {
        method: path.endsWith('watch-ticket') ? 'POST' : 'GET',
        headers: { authorization: `Bearer ${process.env.HUDDLE_LEGACY_SESSION_TOKEN}`, origin },
      })
      denied({ status: response.status, data: await response.text() }, `legacy bearer ${path}`)
    }
    console.log(
      'PASS legacy bearer without proof cannot read account/workspace or mint watch ticket',
    )
  }
  const client = new Client()
  requireStage(await client.view(), 'signin')
  for (const path of [
    '/api/workspaces',
    '/api/account',
    '/api/snapshot?workspaceId=00000000-0000-4000-8000-000000000000',
  ])
    denied(await client.request(path), `anonymous ${path}`)
  for (const [path, body] of [
    ['/api/auth/sign-in/email', { email, password: 'synthetic-password-only' }],
    ['/api/auth/sign-up/email', { name: 'Probe', email, password: 'synthetic-password-only' }],
    ['/api/auth/request-password-reset', { email }],
    ['/api/auth/reset-password', { newPassword: 'synthetic-password-only', token: 'invalid' }],
  ])
    blocked(await client.request(path, body), `blocked password route ${path}`)
  blocked(
    await client.request('/api/auth/device/approve', { userCode: 'INVALID' }),
    'anonymous device approval',
  )
  console.log('PASS anonymous protected APIs, password routes, and device approval deny access')
}
async function onboard() {
  const client = new Client()
  const enrollment = requireStage(await sendAndVerify(client, email), 'enroll').stage
  denied(await client.request('/api/workspaces'), 'email-only workspace read')
  assert.ok(enrollment.secret && enrollment.uri && enrollment.generation)
  const correct = totp(enrollment.uri)
  const incorrect = String((Number(correct) + 1) % 1_000_000).padStart(6, '0')
  const wrong = await client.action({
    kind: 'enrollment.verify',
    generation: enrollment.generation,
    code: incorrect,
  })
  assert.ok(wrong.status >= 400, 'incorrect authenticator proof was accepted')
  const verified = requireStage(
    await client.action({
      kind: 'enrollment.verify',
      generation: enrollment.generation,
      code: correct,
    }),
    'save-recovery',
  )
  assert.ok(verified.stage.codes.length > 0, 'no recovery codes returned')
  denied(await client.request('/api/workspaces'), 'unacknowledged recovery workspace read')
  requireStage(
    await client.action({ kind: 'recovery.ack', batch: verified.stage.batch }),
    'passkey-offer',
  )
  requireStage(await client.action({ kind: 'passkey.skip' }), 'profile')
  const ready = requireStage(
    await client.action({
      kind: 'profile.save',
      profile: { name: 'Probe User', avatar: { kind: 'mascot', shape: 'circle', color: 'indigo' } },
    }),
    'ready',
  )
  assert.equal(ready.stage.user.email, email)
  const workspaces = await client.request('/api/workspaces')
  assert.equal(workspaces.status, 200)
  assert.equal((await client.request('/api/account')).status, 200)
  if (process.env.HUDDLE_PROBE_EXPECT_LEGACY === '1') {
    assert.ok(
      process.env.HUDDLE_LEGACY_FIXTURE,
      'Set HUDDLE_LEGACY_FIXTURE to the synthetic fixture manifest',
    )
    const fixture = JSON.parse(await readFile(process.env.HUDDLE_LEGACY_FIXTURE, 'utf8'))
    assert.equal(ready.stage.user.id, fixture.userId, 'legacy user ID changed')
    assert.equal(workspaces.data.length, fixture.memberships, 'legacy membership count changed')
    let preservedMessages = 0
    for (const workspace of workspaces.data) {
      const snapshot = await client.request(
        `/api/snapshot?workspaceId=${encodeURIComponent(workspace.id)}`,
      )
      assert.equal(snapshot.status, 200)
      for (const channel of snapshot.data.channels) {
        const history = await client.request(
          `/api/messages?channelId=${encodeURIComponent(channel.id)}`,
        )
        assert.equal(history.status, 200)
        preservedMessages += Array.isArray(history.data)
          ? history.data.length
          : (history.data.messages?.length ?? 0)
      }
    }
    assert.equal(preservedMessages, fixture.messages, 'legacy message count changed')
    console.log(
      'PASS legacy user ID, membership and messages preserved through actual email/factor onboarding',
    )
  }
  const account = (await client.request('/api/account')).data
  assert.ok(account.authenticator?.enrolledAt)
  assert.equal(account.recoveryRemaining, verified.stage.codes.length)
  await writeFile(
    statePath,
    JSON.stringify(
      {
        email,
        uri: enrollment.uri,
        recoveryCode: verified.stage.codes[0],
        accountId: ready.stage.user.id,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  )
  await chmod(statePath, 0o600)
  console.log(
    'PASS SMTP email, actual TOTP enrollment, recovery acknowledgement, profile, workspace admission, account inventory',
  )
  console.log(`Private continuation state saved to ${statePath}`)
  return {
    client,
    uri: enrollment.uri,
    recoveryCodes: verified.stage.codes,
    userId: ready.stage.user.id,
  }
}

async function deviceAndSocket({ client, uri, userId }) {
  const device = await new Client().request('/api/auth/device/code', {
    client_id: 'huddle-desktop',
  })
  assert.equal(device.status, 200, `device grant failed with status ${device.status}`)
  const code = device.data
  const body = {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: code.device_code,
    client_id: 'huddle-desktop',
  }
  const native = new Client()
  const pending = await native.request('/api/auth/device/token', body)
  assert.equal(pending.data?.error, 'authorization_pending')
  const claim = await client.request(
    `/api/auth/device?user_code=${encodeURIComponent(code.user_code)}`,
  )
  assert.equal(claim.status, 200)
  assert.equal(claim.data?.status, 'pending')
  const decision = await client.action({
    kind: 'device.decide',
    userCode: code.user_code,
    decision: 'approve',
  })
  requireStage(decision, 'ready')
  await wait((code.interval + 1) * 1000)
  const exchanged = await native.request('/api/auth/device/token', body)
  assert.equal(
    exchanged.status,
    200,
    `approved device exchange failed with status ${exchanged.status}`,
  )
  assert.ok(exchanged.data?.access_token)
  const nativeHeaders = { authorization: `Bearer ${exchanged.data.access_token}` }
  const nativeReady = await fetch(new URL('/api/access', base), { headers: nativeHeaders })
  assert.equal(nativeReady.status, 200)
  assert.equal((await nativeReady.json()).stage.user.id, userId)
  const workspace = await client.request('/api/workspaces', {
    name: `Probe ${randomBytes(4).toString('hex')}`,
  })
  assert.equal(workspace.status, 200)
  const ticket = await client.request('/api/watch-ticket', {})
  assert.equal(ticket.status, 200)
  assert.ok(ticket.data?.ticket)
  const { createRequire } = await import('node:module')
  const WebSocket = createRequire(new URL('../package.json', import.meta.url))('ws')
  const socket = new WebSocket(process.env.HUDDLE_PROBE_WS_URL ?? 'ws://localhost:3001', { origin })
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  socket.send(
    JSON.stringify({
      kind: 'watch',
      workspaceId: workspace.data.id,
      after: '0',
      ticket: ticket.data.ticket,
    }),
  )
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('watch did not establish')), 5000)
    socket.once('message', () => {
      clearTimeout(timer)
      resolve()
    })
    socket.once('close', () => {
      clearTimeout(timer)
      reject(new Error('watch closed before first event'))
    })
  })
  const period = Number(new URL(uri).searchParams.get('period') ?? 30)
  await wait((period - (Math.floor(Date.now() / 1000) % period)) * 1000 + 1500)
  const fresh = await client.action({
    kind: 'security.commit',
    change: { kind: 'recovery.regenerate' },
    proof: { kind: 'totp', code: totp(uri) },
  })
  const batch = requireStage(fresh, 'save-recovery').stage
  assert.ok(batch.codes.length > 0)
  requireStage(await client.action({ kind: 'recovery.ack', batch: batch.batch }), 'ready')
  const stale = await fetch(new URL('/api/workspaces', base), { headers: nativeHeaders })
  denied(
    { status: stale.status, data: await stale.text() },
    'stale native bearer after factor change',
  )
  await new Promise((resolve, reject) => {
    if (socket.readyState === WebSocket.CLOSED) return resolve()
    const timer = setTimeout(
      () => reject(new Error('watch remained open after factor change')),
      5000,
    )
    socket.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  enrolled.recoveryCodes = batch.codes
  console.log(
    'PASS explicit device approval, native bearer, fresh factor change, epoch revocation, socket closure',
  )
}

async function concurrentTotp({ uri }) {
  const first = new Client()
  const second = new Client()
  requireStage(await sendAndVerify(first, email), 'totp')
  requireStage(await sendAndVerify(second, email), 'totp')
  const code = totp(uri)
  const [a, b] = await Promise.all([
    first.action({ kind: 'totp.verify', code }),
    second.action({ kind: 'totp.verify', code }),
  ])
  assert.equal(
    [a, b].filter((item) => item.status === 200).length,
    1,
    'the same TOTP step was accepted by multiple sessions',
  )
  assert.equal([a, b].filter((item) => item.status >= 400).length, 1)
  console.log('PASS concurrent TOTP replay accepts one session')
}

async function concurrentRecovery(enrolled) {
  const first = new Client()
  const second = new Client()
  requireStage(await sendAndVerify(first, email), 'totp')
  requireStage(await sendAndVerify(second, email), 'totp')
  requireStage(await first.action({ kind: 'recovery.choose' }), 'recovery')
  requireStage(await second.action({ kind: 'recovery.choose' }), 'recovery')
  const code = enrolled.recoveryCodes[0]
  const [a, b] = await Promise.all([
    first.action({ kind: 'recovery.verify', code }),
    second.action({ kind: 'recovery.verify', code }),
  ])
  requireStage(a, 'enroll')
  requireStage(b, 'enroll')
  denied(
    await first.request('/api/workspaces'),
    'prepared recovery replacement has no app authority',
  )
  denied(
    await second.request('/api/account'),
    'prepared recovery replacement has no account authority',
  )
  const [installedA, installedB] = await Promise.all([
    first.action({
      kind: 'enrollment.verify',
      generation: a.data.stage.generation,
      code: totp(a.data.stage.uri),
    }),
    second.action({
      kind: 'enrollment.verify',
      generation: b.data.stage.generation,
      code: totp(b.data.stage.uri),
    }),
  ])
  assert.equal(
    [installedA, installedB].filter((item) => item.status === 200).length,
    1,
    'recovery replacement committed more than once',
  )
  assert.equal([installedA, installedB].filter((item) => item.status >= 400).length, 1)
  const winnerClient = installedA.status === 200 ? first : second
  const saved = requireStage(installedA.status === 200 ? installedA : installedB, 'save-recovery')
  assert.ok(saved.stage.codes.length > 0)
  requireStage(
    await winnerClient.action({ kind: 'recovery.ack', batch: saved.stage.batch }),
    'ready',
  )
  denied(
    await enrolled.client.request('/api/workspaces'),
    'old browser session after recovery replacement',
  )
  const replay = await second.action({ kind: 'recovery.verify', code })
  blocked(replay, 'consumed recovery code replay')
  console.log(
    'PASS concurrent recovery preparation has no authority; one atomic replacement, epoch invalidation, consumed-code replay',
  )
}

async function advanced(enrolled) {
  await deviceAndSocket(enrolled)
  await concurrentTotp(enrolled)
  await concurrentRecovery(enrolled)
}

await anonymous()
const enrolled = await onboard()
if (process.env.HUDDLE_PROBE_ADVANCED === '1') await advanced(enrolled)
