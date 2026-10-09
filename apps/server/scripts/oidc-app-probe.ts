import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { z } from 'zod'
import { AccessView, Snapshot, type AccessCommand } from '@huddle/contracts'
import {
  Client,
  invite,
  migratedDatabase,
  onboard,
  startOidcFixture,
  startServer,
  syntheticEmail,
  type ServerProcess,
} from './harness'

const fixtureEmail = syntheticEmail('oidc-fixture')
const fixtureSubject = `fixture-${randomUUID()}`
const database = await migratedDatabase()
const fixture = await startOidcFixture(3390, { sub: fixtureSubject, email: fixtureEmail })
const scratch = new pg.Client({ connectionString: database.url })
let server: ServerProcess | undefined
async function company(client: Client, mode: string) {
  await fixture.mode(mode)
  const start = await client.call('/api/auth/sign-in/oauth2', {
    providerId: 'company',
    callbackURL: '/',
  })
  assert.equal(start.response.status, 200, `OIDC start for ${mode}: ${JSON.stringify(start.value)}`)
  const authorization = new URL(z.object({ url: z.string() }).parse(start.value).url)
  assert.equal(authorization.origin, fixture.issuer)
  const page = await fetch(authorization)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /Sign in and approve/)
  const consent = await fetch(authorization, {
    method: 'POST',
    body: new URLSearchParams([...authorization.searchParams, ['decision', 'approve']]),
    redirect: 'manual',
  })
  assert.equal(consent.status, 302)
  const callback = await client.call(z.string().parse(consent.headers.get('location')))
  const location = new URL(
    z.string().parse(callback.response.headers.get('location')),
    client.origin,
  )
  const access = await client.call('/api/access')
  assert.equal(access.response.status, 200)
  return { location, stage: AccessView.parse(access.value).stage }
}
async function denied(client: Client, label: string) {
  for (const path of ['/api/account', '/api/snapshot']) {
    const { status } = (await client.call(path)).response
    assert.ok(status === 401 || status === 403, `${label} reached ${path} with status ${status}`)
  }
}
async function users(email: string) {
  return (await scratch.query('SELECT id FROM "user" WHERE email = $1', [email])).rows
}
async function finish(client: Client, stage: AccessView['stage']) {
  const steps: AccessCommand[] = [
    { kind: 'passkey.skip' },
    {
      kind: 'profile.save',
      profile: {
        name: 'Fixture Colleague',
        avatar: { kind: 'mascot', shape: 'square', color: 'indigo' },
      },
    },
  ]
  if (stage.kind === 'profile') steps.shift()
  for (const step of stage.kind === 'ready' ? [] : steps) stage = (await client.act(step)).stage
  assert(stage.kind === 'ready', `company sign-in reaches ready, not ${stage.kind}`)
  return stage.user
}
try {
  await scratch.connect()
  const setupCode = `oidc-${randomUUID()}`
  server = await startServer({
    databaseUrl: database.url,
    port: 3310,
    entry: 'scripts/access-test-server.ts',
    env: {
      SETUP_CODE: setupCode,
      ...fixture.serverEnv,
    },
  })
  const origin = server.origin
  const admin = new Client(origin)
  await onboard(admin, { code: setupCode, serverName: 'OIDC probe' })

  for (const mode of [
    'missing_id_token',
    'wrong_issuer',
    'wrong_audience',
    'missing_email_verified',
    'unverified_email',
    'wrong_nonce',
    'missing_sub',
  ]) {
    const client = new Client(origin)
    const { stage } = await company(client, mode)
    assert.equal(stage.kind, 'signin', `${mode} unexpectedly admitted`)
    await denied(client, mode)
    process.stdout.write(`PASS OIDC ${mode} refused by public APIs\n`)
  }

  async function refused(email: string, label: string) {
    const stranger = new Client(origin)
    const rejected = await company(stranger, 'valid')
    assert.equal(
      rejected.location.searchParams.get('error'),
      'not_invited',
      `${label} is sent back with not_invited, not ${rejected.location.href}`,
    )
    assert.equal(rejected.stage.kind, 'signin')
    await denied(stranger, label)
    assert.deepEqual(await users(email), [], `${label} creates no user row`)
  }
  await refused(fixtureEmail, 'an uninvited company identity')
  await invite(admin, fixtureEmail)
  const strangerEmail = syntheticEmail('oidc-stranger')
  await fixture.identity(`stranger-${randomUUID()}`, strangerEmail)
  await refused(strangerEmail, 'another uninvited identity while an invitation is open')
  await fixture.identity(fixtureSubject, fixtureEmail)
  process.stdout.write('PASS OIDC valid but uninvited new identities refused without a user row\n')

  const colleague = new Client(origin)
  const admitted = await company(colleague, 'valid')
  assert.equal(admitted.location.searchParams.get('error'), null)
  const user = await finish(colleague, admitted.stage)
  assert.equal(user.email, fixtureEmail)
  const snapshot = await colleague.call('/api/snapshot')
  assert.equal(snapshot.response.status, 200, 'the invited company user reads the server')
  assert.equal(Snapshot.parse(snapshot.value).server.role, 'member')
  assert.equal((await colleague.call('/api/account')).response.status, 200)
  process.stdout.write(
    'PASS OIDC verified ID token for an invited identity admits account/server\n',
  )

  const returning = new Client(origin)
  const mismatch = await company(returning, 'userinfo_subject_mismatch')
  assert.equal(
    (await finish(returning, mismatch.stage)).id,
    user.id,
    'unused userinfo cannot change the verified ID-token identity',
  )
  assert.equal((await returning.call('/api/snapshot')).response.status, 200)
  process.stdout.write('PASS unused userinfo cannot change the verified ID-token identity\n')
} finally {
  await server?.stop()
  await fixture.stop()
  await scratch.end().catch(() => undefined)
  await database.drop()
}
