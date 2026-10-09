import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { AccessView } from '@huddle/contracts'
import {
  Client,
  migratedDatabase,
  onboard,
  startOidcFixture,
  startServer,
  syntheticEmail,
  type ServerProcess,
} from './harness'

const port = 3330
const setupCode = `policy-${randomUUID()}`
const database = await migratedDatabase()
const fixture = await startOidcFixture(3392, {
  sub: `policy-${randomUUID()}`,
  email: syntheticEmail('policy'),
})
let server: ServerProcess | undefined
async function serve(policy: 'mixed' | 'sso-only') {
  await server?.stop()
  server = await startServer({
    databaseUrl: database.url,
    port,
    entry: 'scripts/access-test-server.ts',
    env: {
      AUTH_POLICY: policy,
      SETUP_CODE: setupCode,
      ...fixture.serverEnv,
    },
  })
  return server.origin
}
async function stage(origin: string) {
  return AccessView.parse(await (await fetch(`${origin}/api/access`)).json()).stage
}
try {
  let origin = await serve('sso-only')
  assert.deepEqual(
    await stage(origin),
    { kind: 'setup', methods: ['company'] },
    'an SSO-only server that is not set up offers company setup only',
  )
  const localSetup = await new Client(origin).call('/api/access', {
    kind: 'setup.start',
    code: setupCode,
    serverName: 'Policy check',
    email: 'admin@huddle.test',
  })
  assert.equal(localSetup.response.status, 503, 'SSO-only refuses email onboarding')

  origin = await serve('mixed')
  const admin = new Client(origin)
  await onboard(admin, { code: setupCode, serverName: 'Policy check' })
  const bearer = new Client(origin)
  bearer.token = admin.sessionToken()
  assert.equal(
    (await bearer.call('/api/snapshot')).response.status,
    200,
    'the TOTP-proved admin session reads the server under the mixed policy',
  )

  origin = await serve('sso-only')
  for (const client of [admin, bearer])
    for (const [path, body] of [
      ['/api/snapshot', undefined],
      ['/api/account', undefined],
      ['/api/watch-ticket', {}],
    ] as const)
      assert.equal(
        (await client.call(path, body)).response.status,
        401,
        `SSO-only denies the local session ${client === bearer ? 'bearer' : 'cookie'} at ${path}`,
      )
  for (const [path, body] of [
    ['/api/access', { kind: 'email.send', email: 'blocked@huddle.test' }],
    ['/api/access/passkey/authenticate/options', { purpose: 'signin' }],
  ] as const)
    assert.equal(
      (await new Client(origin).call(path, body)).response.status,
      503,
      `SSO-only refuses ${path}`,
    )
  assert.deepEqual(
    await stage(origin),
    { kind: 'signin', methods: ['company'] },
    'an onboarded SSO-only server offers company sign-in only',
  )
  process.stdout.write(
    'PASS SSO-only offers company-only setup and sign-in, refuses email onboarding, and denies previously proved local sessions and local authentication routes.\n',
  )
} finally {
  await server?.stop()
  await fixture.stop()
  await database.drop()
}
