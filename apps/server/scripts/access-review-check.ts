import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'
import { z } from 'zod'
import { TOTP } from 'otpauth'
import { AccessView, Snapshot, type AccessCommand } from '@huddle/contracts'
import {
  emailCode,
  migratedDatabase,
  startOidcFixture,
  startServer,
  syntheticEmail,
  type ServerProcess,
} from './harness'

const port = Number(process.env.TEST_PORT ?? 3180)
const base = `http://localhost:${port}`
const email = syntheticEmail('review-owner')
const subject = `review-${randomUUID()}`
const setupCode = `review-${randomUUID()}`
const database = await migratedDatabase()
const db = new pg.Pool({ connectionString: database.url })
const scratchEnv = { ...process.env, DATABASE_URL: database.url, SERVER_URL: base }
const fixture = await startOidcFixture(Number(process.env.OIDC_FIXTURE_PORT ?? 3184), {
  sub: subject,
  email,
})
const issuer = fixture.issuer
let server: ServerProcess | undefined
async function start(policy = 'mixed') {
  server = await startServer({
    databaseUrl: database.url,
    port,
    entry: 'scripts/access-test-server.ts',
    env: { AUTH_POLICY: policy, SETUP_CODE: setupCode, ...fixture.serverEnv },
  })
}
async function stop() {
  await server?.stop()
  server = undefined
}
class Client {
  cookies = new Map<string, string>()
  continuation = ''
  constructor(readonly native = true) {}
  async call(path: string, body?: unknown) {
    const response = await fetch(new URL(path, base), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Origin: base,
        'Content-Type': 'application/json',
        ...(this.native
          ? { 'X-Huddle-Client': 'native', 'X-Huddle-Continuation': this.continuation }
          : {}),
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
async function company(client: Client, extra: Record<string, unknown> = {}) {
  const start = await client.call('/api/auth/sign-in/oauth2', {
    providerId: 'company',
    callbackURL: '/login',
    ...extra,
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
  const callback = await client.call(location)
  assert.equal(callback.status, 302)
  return new URL(z.string().parse(callback.headers.get('location')), base)
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
        env: { ...scratchEnv, HUDDLE_IDENTITY_CONFIRMED: 'yes' },
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
  await start('sso-only')
  assert.deepEqual(await new Client().act({ kind: 'signout' }), {
    kind: 'setup',
    methods: ['company'],
  })
  const adminEmail = syntheticEmail('review-admin')
  await fixture.identity(`admin-${randomUUID()}`, adminEmail)
  const wrongSetup = await new Client(false).call('/api/auth/sign-in/oauth2', {
    providerId: 'company',
    callbackURL: '/login',
    purpose: 'setup',
    code: 'not-the-setup-code',
    serverName: 'Review server',
  })
  assert.equal(wrongSetup.status, 400, 'company setup requires the setup code')
  const admin = new Client(false)
  const onboarded = await company(admin, {
    purpose: 'setup',
    code: setupCode,
    serverName: 'Review server',
  })
  assert.equal(onboarded.pathname, '/login')
  assert.equal(onboarded.searchParams.get('error'), null)
  await admin.act({
    kind: 'profile.save',
    profile: { name: 'Review admin', avatar: { kind: 'mascot', shape: 'circle', color: 'teal' } },
  })
  const adminServer = Snapshot.parse(await (await admin.call('/api/snapshot')).json())
  assert.equal(adminServer.server.role, 'admin')
  assert.equal(adminServer.server.name, 'Review server')
  assert.equal(
    (
      await new Client(false).call('/api/auth/sign-in/oauth2', {
        providerId: 'company',
        callbackURL: '/login',
        purpose: 'setup',
        code: setupCode,
        serverName: 'Second server',
      })
    ).status,
    400,
    'company setup cannot run twice',
  )
  process.stdout.write(
    'PASS an SSO-only server onboards its admin through company login with the setup code, once.\n',
  )

  const strangerEmail = syntheticEmail('review-stranger')
  await fixture.identity(`stranger-${randomUUID()}`, strangerEmail)
  const rejected = await company(new Client(false))
  assert.equal(rejected.pathname, '/login')
  assert.equal(rejected.searchParams.get('error'), 'not_invited')
  assert.equal(
    (await db.query('SELECT 1 FROM "user" WHERE email=$1', [strangerEmail])).rowCount,
    0,
    'an uninvited company identity creates no account',
  )
  const invitedEmail = syntheticEmail('review-invited')
  assert.equal((await admin.call('/api/invitations', { email: invitedEmail })).status, 200)
  await fixture.identity(`invited-${randomUUID()}`, invitedEmail)
  const colleague = new Client(false)
  const admitted = await company(colleague)
  assert.equal(admitted.searchParams.get('error'), null)
  await colleague.act({
    kind: 'profile.save',
    profile: { name: 'Invited colleague', avatar: { kind: 'mascot', shape: 'bean', color: 'sky' } },
  })
  const joined = Snapshot.parse(await (await colleague.call('/api/snapshot')).json())
  assert.equal(joined.server.role, 'member')
  assert.equal(
    (
      await db.query('SELECT 1 FROM invitation WHERE email=$1 AND accepted_at IS NOT NULL', [
        invitedEmail,
      ])
    ).rowCount,
    1,
  )
  process.stdout.write(
    'PASS an uninvited company identity is rejected without an account; an invited one joins as a member.\n',
  )
  assert.equal((await admin.call('/api/invitations', { email })).status, 200)
  await fixture.identity(subject, email)
  await stop()
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
    (await owner.call('/api/snapshot')).status,
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
  const lockedEmail = syntheticEmail('review-lock')
  assert.equal((await admin.call('/api/invitations', { email: lockedEmail })).status, 200)
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
  const expiredEmail = syntheticEmail('review-expired')
  assert.equal((await admin.call('/api/invitations', { email: expiredEmail })).status, 200)
  const expiredReset = await issueReset(expiredEmail)
  const expiredClient = new Client()
  await expiredClient.act({ kind: 'reset.redeem', capability: expiredReset.capability })
  await db.query('UPDATE account_reset SET expires_at=now() WHERE id=$1', [expiredReset.id])
  const resetSentAt = Date.now()
  const expiry = (await db.query('SELECT expires_at FROM account_reset WHERE id=$1', [reset.id]))
    .rows[0].expires_at
  const different = new Client()
  different.continuation = recovering.continuation
  const differentEmail = syntheticEmail('review-other')
  assert.equal((await admin.call('/api/invitations', { email: differentEmail })).status, 200)
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
  assert.equal((await owner.call('/api/snapshot')).status, 401)
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
} catch (error) {
  process.stderr.write(server?.logs() ?? '')
  throw error
} finally {
  await stop()
  await fixture.stop()
  await db.end()
  await database.drop()
}
