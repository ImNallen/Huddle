import assert from 'node:assert/strict'
import { z } from 'zod'
import { readFile } from 'node:fs/promises'

const base = process.env.SERVER_URL ?? 'http://localhost:3000'
const issuer = process.env.OIDC_FIXTURE_ISSUER
assert(issuer, 'Set OIDC_FIXTURE_ISSUER to the disposable provider')
const cookies = new Map<string, string>()
async function call(path: string, body?: unknown) {
  const response = await fetch(new URL(path, base), {
    method: body ? 'POST' : 'GET',
    headers: {
      Origin: base,
      'Content-Type': 'application/json',
      Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  })
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(';')[0] ?? ''
    const i = pair.indexOf('=')
    cookies.set(pair.slice(0, i), pair.slice(i + 1))
  }
  return response
}
async function company(
  purpose?: 'first-passkey' | 'session-security',
  change?: { kind: 'sessions.revoke-others' } | { kind: 'session.revoke'; id: string },
) {
  const start = await call('/api/auth/sign-in/oauth2', {
    providerId: 'company',
    callbackURL: '/',
    purpose,
    change,
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
  const callback = consent.headers.get('location')
  assert(callback)
  await call(callback)
  return z
    .object({ stage: z.object({ kind: z.string() }) })
    .parse(await (await call('/api/access')).json()).stage.kind
}
await fetch(`${issuer}/__fixture/mode`, {
  method: 'POST',
  body: new URLSearchParams({ mode: 'valid' }),
})
let stage = await company()
if (stage === 'passkey-offer') {
  await call('/api/access', { kind: 'passkey.skip' })
  stage = 'profile'
}
if (stage === 'profile')
  await call('/api/access', {
    kind: 'profile.save',
    profile: {
      name: 'Company fixture',
      avatar: { kind: 'mascot', shape: 'circle', color: 'indigo' },
    },
  })
assert.equal(await company(), 'ready')
if (process.env.AUTH_POLICY !== 'sso-only') {
  assert.equal(await company('first-passkey'), 'passkey-offer')
  assert.equal(
    (await call('/api/access/passkey/register/options', { name: 'Company first key' })).status,
    200,
  )
  await call('/api/access', { kind: 'passkey.skip' })
} else {
  assert.equal(
    (await call('/api/access', { kind: 'email.send', email: 'blocked@huddle.test' })).status,
    503,
  )
  assert.equal(
    (await call('/api/access/passkey/authenticate/options', { purpose: 'signin' })).status,
    503,
  )
  if (process.env.ACCESS_TEST_STATE) {
    const state = z
      .object({ localToken: z.string() })
      .parse(JSON.parse(await readFile(process.env.ACCESS_TEST_STATE, 'utf8')))
    assert.equal(
      (
        await fetch(`${base}/api/workspaces`, {
          headers: { Authorization: `Bearer ${state.localToken}` },
        })
      ).status,
      401,
    )
  }
}
await company()
const stale = [...cookies].map(([key, value]) => `${key}=${value}`).join('; ')
assert.equal(await company('session-security', { kind: 'sessions.revoke-others' }), 'ready')
assert.equal((await fetch(`${base}/api/workspaces`, { headers: { Cookie: stale } })).status, 401)
assert.equal((await call('/api/workspaces')).status, 200)
assert.equal(
  (
    await call('/api/auth/sign-in/oauth2', {
      providerId: 'company',
      purpose: 'session-security',
      change: { kind: 'recovery.regenerate' },
    })
  ).status,
  400,
)
process.stdout.write(
  'PASS scoped fresh company session revocation rotates authority and cannot request local factor changes.\n',
)
process.stdout.write(
  process.env.AUTH_POLICY === 'sso-only'
    ? 'PASS SSO-only company login and session confirmation.\n'
    : 'PASS returning company login goes ready; explicit first-passkey re-login alone authorizes its fresh registration offer.\n',
)
