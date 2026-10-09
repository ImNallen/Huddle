import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { z } from 'zod'
import { AccessView } from '@huddle/contracts'
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

const email = syntheticEmail('company')
const setupCode = `company-${randomUUID()}`
const database = await migratedDatabase()
const fixture = await startOidcFixture(3391, { sub: `company-${randomUUID()}`, email })
const scratch = new pg.Client({ connectionString: database.url })
let server: ServerProcess | undefined
async function serve(policy: 'mixed' | 'sso-only') {
  await server?.stop()
  server = await startServer({
    databaseUrl: database.url,
    port: 3320,
    entry: 'scripts/access-test-server.ts',
    env: {
      AUTH_POLICY: policy,
      SETUP_CODE: setupCode,
      ...fixture.serverEnv,
    },
  })
  return server.origin
}
async function company(
  client: Client,
  options: {
    purpose?: 'first-passkey' | 'session-security'
    change?: { kind: 'sessions.revoke-others' }
  } = {},
) {
  const start = await client.call('/api/auth/sign-in/oauth2', {
    providerId: 'company',
    callbackURL: '/',
    ...options,
  })
  assert.equal(start.response.status, 200, JSON.stringify(start.value))
  const authorization = new URL(z.object({ url: z.string() }).parse(start.value).url)
  assert.equal(authorization.origin, fixture.issuer)
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
  return { error: location.searchParams.get('error'), stage: AccessView.parse(access.value).stage }
}
try {
  await scratch.connect()
  let origin = await serve('mixed')
  const admin = new Client(origin)
  await onboard(admin, { code: setupCode, serverName: 'Company check' })

  const stranger = await company(new Client(origin))
  assert.equal(stranger.error, 'not_invited', 'an uninvited new company identity is refused')
  assert.equal(stranger.stage.kind, 'signin')
  assert.equal(
    (await scratch.query('SELECT 1 FROM "user" WHERE email = $1', [email])).rowCount,
    0,
    'a refused company identity creates no user row',
  )
  await invite(admin, email)
  const colleague = new Client(origin)
  const first = await company(colleague)
  assert.equal(first.error, null)
  assert.equal(first.stage.kind, 'passkey-offer', 'an invited company identity is admitted')
  await colleague.act({ kind: 'passkey.skip' })
  const profiled = await colleague.act({
    kind: 'profile.save',
    profile: {
      name: 'Company fixture',
      avatar: { kind: 'mascot', shape: 'circle', color: 'indigo' },
    },
  })
  assert.equal(profiled.stage.kind, 'ready')
  assert.equal((await company(colleague)).stage.kind, 'ready', 'returning company login is ready')
  process.stdout.write(
    'PASS a new company identity needs an invitation: uninvited is refused without a user row, invited is admitted.\n',
  )

  for (const policy of ['mixed', 'sso-only'] as const) {
    origin = await serve(policy)
    const client = new Client(origin)
    assert.equal((await company(client)).stage.kind, 'ready')
    if (policy === 'mixed') {
      assert.equal(
        (await company(client, { purpose: 'first-passkey' })).stage.kind,
        'passkey-offer',
        'explicit first-passkey re-login offers a passkey',
      )
      assert.equal(
        (await client.call('/api/access/passkey/register/options', { name: 'Company first key' }))
          .response.status,
        200,
        'the fresh first-passkey login authorizes registration options',
      )
      await client.act({ kind: 'passkey.skip' })
    } else {
      for (const [path, body] of [
        ['/api/access', { kind: 'email.send', email: 'blocked@huddle.test' }],
        ['/api/access/passkey/authenticate/options', { purpose: 'signin' }],
      ] as const)
        assert.equal(
          (await client.call(path, body)).response.status,
          503,
          `SSO-only refuses ${path}`,
        )
      assert.equal(
        (await admin.call('/api/snapshot')).response.status,
        401,
        'SSO-only denies the local admin session',
      )
    }
    const stale = new Client(origin)
    stale.cookies = new Map(client.cookies)
    const revoked = await company(client, {
      purpose: 'session-security',
      change: { kind: 'sessions.revoke-others' },
    })
    assert.equal(revoked.stage.kind, 'ready')
    assert.equal(
      (await stale.call('/api/snapshot')).response.status,
      401,
      `${policy}: revoking other sessions rotates the pre-confirmation session out`,
    )
    assert.equal((await client.call('/api/snapshot')).response.status, 200)
    assert.equal(
      (
        await client.call('/api/auth/sign-in/oauth2', {
          providerId: 'company',
          purpose: 'session-security',
          change: { kind: 'recovery.regenerate' },
        })
      ).response.status,
      400,
      'company confirmation cannot request a local factor change',
    )
    process.stdout.write(
      `PASS ${policy}: scoped fresh company session revocation rotates authority and cannot request local factor changes.\n`,
    )
  }
  process.stdout.write(
    'PASS returning company login goes ready; explicit first-passkey re-login alone authorizes its fresh registration offer; SSO-only company login and session confirmation.\n',
  )
} finally {
  await server?.stop()
  await fixture.stop()
  await scratch.end().catch(() => undefined)
  await database.drop()
}
