import assert from 'node:assert/strict'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'
import { z } from 'zod'
import { TOTP } from 'otpauth'
import { AccessView, type AccessCommand } from '@huddle/contracts'

const base = z.url().parse(process.env.SERVER_URL)
const issuer = z.url().parse(process.env.OIDC_FIXTURE_ISSUER)
const email = z.email().parse(process.env.OIDC_FIXTURE_EMAIL)
const subject = z.string().min(1).parse(process.env.OIDC_FIXTURE_SUBJECT)
const mail = z.url().parse(process.env.MAILPIT_URL)
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL })
let server: ChildProcess | undefined
let logs = ''
async function start(policy = 'mixed') {
  logs = ''
  server = spawn(process.execPath, ['--import', 'tsx', 'scripts/access-test-server.ts'], {
    env: { ...process.env, AUTH_POLICY: policy },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout?.on('data', (chunk: Buffer) => (logs += chunk.toString()))
  server.stderr?.on('data', (chunk: Buffer) => (logs += chunk.toString()))
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(logs)
    if (
      await fetch(`${base}/api/health`).then(
        (r) => r.ok,
        () => false,
      )
    )
      return
    await delay(100)
  }
  throw new Error(`Server did not start: ${logs}`)
}
async function stop() {
  if (!server || server.exitCode !== null) return
  const exited = once(server, 'exit')
  server.kill('SIGTERM')
  await exited
  server = undefined
}
class Client {
  cookies = new Map<string, string>()
  continuation = ''
  async call(path: string, body?: unknown) {
    const response = await fetch(new URL(path, base), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Origin: base,
        'Content-Type': 'application/json',
        'X-Huddle-Client': 'native',
        'X-Huddle-Continuation': this.continuation,
        Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    })
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0] ?? ''
      const separator = pair.indexOf('=')
      this.cookies.set(pair.slice(0, separator), pair.slice(separator + 1))
    }
    return response
  }
  async act(body: AccessCommand) {
    const response = await this.call('/api/access', body)
    const value: unknown = await response.json()
    assert.equal(response.status, 200, JSON.stringify(value))
    const view = AccessView.parse(value)
    this.continuation = view.continuation ?? this.continuation
    return view.stage
  }
}
async function emailCode(address: string) {
  const listing = z
    .object({
      messages: z.array(
        z.object({ ID: z.string(), To: z.array(z.object({ Address: z.string() })) }),
      ),
    })
    .parse(await (await fetch(`${mail}/api/v1/messages`)).json())
  const message = listing.messages.find((m) => m.To.some((to) => to.Address === address))
  assert(message, `Missing email for ${address}`)
  const detail = z
    .object({ Text: z.string() })
    .parse(await (await fetch(`${mail}/api/v1/message/${message.ID}`)).json())
  const code = detail.Text.match(/\b\d{6}\b/)?.[0]
  assert(code)
  return code
}
async function company(client: Client) {
  const start = await client.call('/api/auth/sign-in/oauth2', {
    providerId: 'company',
    callbackURL: '/login',
  })
  assert.equal(start.status, 200)
  const authorization = new URL(z.object({ url: z.string() }).parse(await start.json()).url)
  assert.equal(authorization.origin, issuer)
  const consent = await fetch(authorization, {
    method: 'POST',
    body: new URLSearchParams([...authorization.searchParams, ['decision', 'approve']]),
    redirect: 'manual',
  })
  assert.equal(consent.status, 302)
  const location = consent.headers.get('location')
  assert(location)
  assert.equal((await client.call(location)).status, 302)
}
async function issueReset(address: string) {
  await new Client().act({ kind: 'reset.request', email: address })
  const result = await db.query(
    'SELECT id FROM account_reset WHERE email=$1 ORDER BY requested_at DESC LIMIT 1',
    [address],
  )
  const id = z.string().parse(result.rows[0].id)
  const file = join(tmpdir(), `huddle-review-reset-${randomUUID()}`)
  try {
    execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/account-reset.ts',
        'issue',
        id,
        'review-fixture',
        'Synthetic owner independently confirmed for regression',
        file,
      ],
      {
        env: { ...process.env, HUDDLE_IDENTITY_CONFIRMED: 'yes' },
        stdio: 'pipe',
      },
    )
    return { id, capability: (await readFile(file, 'utf8')).trim() }
  } finally {
    await unlink(file).catch(() => undefined)
  }
}
function enrollmentCommand(stage: Extract<AccessView['stage'], { kind: 'enroll' }>): AccessCommand {
  return {
    kind: 'enrollment.verify',
    generation: stage.generation,
    code: new TOTP({ secret: stage.secret, algorithm: 'SHA1', digits: 6, period: 30 }).generate(),
  }
}
try {
  const id = randomUUID()
  await db.query(
    'INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,false,now(),now())',
    [id, 'Preserved company owner', email],
  )
  const link = randomUUID()
  await db.query(
    'INSERT INTO account(id,"accountId","providerId","userId","createdAt","updatedAt") VALUES($1,$2,\'company\',$3,now(),now())',
    [link, subject, id],
  )
  await start()
  const pending = new Client()
  const sentAt = Date.now()
  await pending.act({ kind: 'email.send', email })
  const enrollment = await pending.act({ kind: 'email.verify', code: await emailCode(email) })
  assert(enrollment.kind === 'enroll' && !enrollment.replacing)
  const owner = new Client()
  await company(owner)
  await owner.act({ kind: 'passkey.skip' })
  await owner.act({
    kind: 'profile.save',
    profile: {
      name: 'Preserved owner',
      avatar: { kind: 'mascot', shape: 'circle', color: 'indigo' },
    },
  })
  const denied = await pending.call('/api/access', enrollmentCommand(enrollment))
  assert.equal(
    denied.status,
    401,
    'Pending email enrollment must lose authority after company establishment',
  )
  assert.equal((await db.query('SELECT 1 FROM local_factor WHERE user_id=$1', [id])).rowCount, 0)
  assert.equal(
    (await owner.call('/api/workspaces')).status,
    200,
    'Company session must retain its epoch',
  )
  assert.equal(
    (await db.query('SELECT id FROM account WHERE id=$1 AND "userId"=$2', [link, id])).rowCount,
    1,
  )
  process.stdout.write(
    'PASS preserved company link established between email preparation and final enrollment blocks local installation.\n',
  )

  const locked = new Client()
  const lockedEmail = `review-lock-${randomUUID()}@huddle.test`
  const lockSentAt = Date.now()
  await locked.act({ kind: 'email.send', email: lockedEmail })
  const correct = await emailCode(lockedEmail)
  const wrong = String((Number(correct) + 1) % 1000000).padStart(6, '0')
  for (let i = 0; i < 5; i++)
    assert.equal(
      (await locked.call('/api/access', { kind: 'email.verify', code: wrong })).status,
      400,
    )
  await stop()
  await start()
  assert.equal(
    (await locked.call('/api/access', { kind: 'email.send', email: lockedEmail })).status,
    429,
    'Email cooldown survives process restart',
  )
  assert.equal(
    (await locked.call('/api/access', { kind: 'email.verify', code: correct })).status,
    429,
    'Failed-attempt lockout survives process restart',
  )
  process.stdout.write(
    'PASS email cooldown and failed-attempt denial survive a real server process restart.\n',
  )

  const reset = await issueReset(email)
  await delay(Math.max(0, 61000 - (Date.now() - sentAt)))
  const recovering = new Client()
  await recovering.act({ kind: 'reset.redeem', capability: reset.capability })
  const expiredEmail = `review-expired-${randomUUID()}@huddle.test`
  const expiredReset = await issueReset(expiredEmail)
  const expiredClient = new Client()
  await expiredClient.act({ kind: 'reset.redeem', capability: expiredReset.capability })
  await db.query('UPDATE account_reset SET expires_at=now() WHERE id=$1', [expiredReset.id])
  const resetSentAt = Date.now()
  const expiry = (await db.query('SELECT expires_at FROM account_reset WHERE id=$1', [reset.id]))
    .rows[0].expires_at
  const different = new Client()
  different.continuation = recovering.continuation
  const differentEmail = `review-other-${randomUUID()}@huddle.test`
  await different.act({ kind: 'email.send', email: differentEmail })
  const ordinary = await different.act({
    kind: 'email.verify',
    code: await emailCode(differentEmail),
  })
  assert(
    ordinary.kind === 'enroll' && !ordinary.replacing,
    'Reset resend must not transfer authority to another email',
  )
  await delay(Math.max(0, 61000 - (Date.now() - lockSentAt)))
  const fresh = new Client()
  await fresh.act({ kind: 'email.send', email: lockedEmail })
  assert.equal(
    (await fresh.call('/api/access', { kind: 'email.verify', code: await emailCode(lockedEmail) }))
      .status,
    429,
    'A fresh ceremony cannot bypass account email lockout',
  )
  await delay(Math.max(0, 61000 - (Date.now() - resetSentAt)))
  await expiredClient.act({ kind: 'email.send', email: expiredEmail })
  const expiredStage = await expiredClient.act({
    kind: 'email.verify',
    code: await emailCode(expiredEmail),
  })
  assert(
    expiredStage.kind === 'enroll' && !expiredStage.replacing,
    'Resend cannot retain an expired reset capability',
  )
  await recovering.act({ kind: 'email.send', email: email.toUpperCase() })
  const replacement = await recovering.act({ kind: 'email.verify', code: await emailCode(email) })
  assert(
    replacement.kind === 'enroll' && replacement.replacing,
    'Same-email resend must preserve operator reset authorization',
  )
  assert.deepEqual(
    (await db.query('SELECT expires_at FROM account_reset WHERE id=$1', [reset.id])).rows[0]
      .expires_at,
    expiry,
    'Resend cannot extend reset capability lifetime',
  )
  assert.equal((await recovering.act(enrollmentCommand(replacement))).kind, 'save-recovery')
  assert.equal(
    (await db.query('SELECT 1 FROM account_reset WHERE id=$1 AND used_at IS NOT NULL', [reset.id]))
      .rowCount,
    1,
  )
  assert.equal(
    (await db.query('SELECT 1 FROM account WHERE id=$1 AND "userId"=$2', [link, id])).rowCount,
    1,
  )
  assert.equal((await owner.call('/api/workspaces')).status, 401)
  process.stdout.write(
    'PASS same-email reset resend preserves authorized replacement, original expiry, single use, company link and session revocation; different email gets no reset authority.\n',
  )

  await stop()
  await start('sso-only')
  const blockedEmail = `review-sso-${randomUUID()}@huddle.test`
  assert.equal(
    (await new Client().call('/api/access', { kind: 'reset.request', email: blockedEmail })).status,
    503,
  )
  assert.equal(
    (await db.query('SELECT 1 FROM account_reset WHERE email=$1', [blockedEmail])).rowCount,
    0,
    'SSO-only must not create an unusable local reset request',
  )
  process.stdout.write(
    'PASS SSO-only reset request rejected without recording an operator request.\n',
  )
} finally {
  await stop()
  await db.end()
}
