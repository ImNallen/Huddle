import assert from 'node:assert/strict'
import { createHash, createPublicKey, createVerify, randomBytes } from 'node:crypto'

const issuer = process.env.OIDC_FIXTURE_ISSUER ?? 'http://127.0.0.1:3174'
const discovery = await (await fetch(`${issuer}/.well-known/openid-configuration`)).json()
assert.equal(discovery.issuer, issuer)
assert.equal(discovery.token_endpoint, `${issuer}/token`)
const jwks = await (await fetch(discovery.jwks_uri)).json()
assert.equal(jwks.keys.length, 1)
const verifier = randomBytes(32).toString('base64url')
const challenge = createHash('sha256').update(verifier).digest('base64url')
const redirectUri = 'http://127.0.0.1:3170/api/auth/oauth2/callback/company'
const authorize = new URL(discovery.authorization_endpoint)
for (const [key, value] of Object.entries({
  client_id: 'huddle-test',
  redirect_uri: redirectUri,
  response_type: 'code',
  scope: 'openid profile email',
  state: 'fixture-state',
  nonce: 'fixture-nonce',
  code_challenge: challenge,
  code_challenge_method: 'S256',
}))
  authorize.searchParams.set(key, value)
const page = await fetch(authorize)
assert.equal(page.status, 200)
assert.match(await page.text(), /Sign in and approve/)
const localhostAuthorize = new URL(authorize)
localhostAuthorize.searchParams.set(
  'redirect_uri',
  'http://localhost:3170/api/auth/oauth2/callback/company',
)
assert.equal((await fetch(localhostAuthorize)).status, 200)
const consent = await fetch(authorize, {
  method: 'POST',
  body: new URLSearchParams([...authorize.searchParams, ['decision', 'approve']]),
  redirect: 'manual',
})
assert.equal(consent.status, 302)
const callback = new URL(consent.headers.get('location'))
assert.equal(callback.searchParams.get('state'), 'fixture-state')
const code = callback.searchParams.get('code')
const requestToken = (codeValue, verifierValue) =>
  fetch(discovery.token_endpoint, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: codeValue,
      redirect_uri: redirectUri,
      client_id: 'huddle-test',
      client_secret: 'huddle-test-secret',
      code_verifier: verifierValue,
    }),
  })
assert.equal((await requestToken(code, 'wrong')).status, 400)
const response = await requestToken(code, verifier)
assert.equal(response.status, 200)
const tokens = await response.json()
assert.equal((await requestToken(code, verifier)).status, 400)
assert.equal(tokens.token_type, 'Bearer')
const [head, payload, signature] = tokens.id_token.split('.')
const claims = JSON.parse(Buffer.from(payload, 'base64url'))
assert.equal(claims.iss, issuer)
assert.equal(claims.aud, 'huddle-test')
assert.equal(claims.nonce, 'fixture-nonce')
assert.equal(claims.email_verified, true)
assert.ok(
  createVerify('RSA-SHA256')
    .update(`${head}.${payload}`)
    .end()
    .verify(
      createPublicKey({ key: jwks.keys[0], format: 'jwk' }),
      Buffer.from(signature, 'base64url'),
    ),
)
const info = await fetch(discovery.userinfo_endpoint, {
  headers: { authorization: `Bearer ${tokens.access_token}` },
})
assert.equal(info.status, 200)
assert.equal((await info.json()).sub, claims.sub)
for (const mode of [
  'missing_id_token',
  'wrong_issuer',
  'wrong_audience',
  'missing_email_verified',
  'unverified_email',
  'wrong_nonce',
  'missing_sub',
  'userinfo_subject_mismatch',
]) {
  const set = await fetch(`${issuer}/__fixture/mode`, {
    method: 'POST',
    body: new URLSearchParams({ mode }),
  })
  assert.equal(set.status, 200)
  const consent = await fetch(authorize, {
    method: 'POST',
    body: new URLSearchParams([...authorize.searchParams, ['decision', 'approve']]),
    redirect: 'manual',
  })
  const code = new URL(consent.headers.get('location')).searchParams.get('code')
  const tokenResponse = await requestToken(code, verifier)
  assert.equal(tokenResponse.status, 200)
  const token = await tokenResponse.json()
  if (mode === 'userinfo_subject_mismatch') {
    const userinfo = await fetch(discovery.userinfo_endpoint, {
      headers: { authorization: `Bearer ${token.access_token}` },
    })
    assert.equal(userinfo.status, 200)
    assert.notEqual((await userinfo.json()).sub, 'fixture-user-1')
  }
  if (mode === 'missing_id_token')
    assert.ok(token.id_token === undefined, 'missing-ID-token mode returned an ID token')
  else {
    const fault = JSON.parse(Buffer.from(token.id_token.split('.')[1], 'base64url'))
    if (mode === 'wrong_issuer') assert.notEqual(fault.iss, issuer)
    if (mode === 'wrong_audience') assert.notEqual(fault.aud, 'huddle-test')
    if (mode === 'missing_email_verified') assert.equal(fault.email_verified, undefined)
    if (mode === 'unverified_email') assert.equal(fault.email_verified, false)
    if (mode === 'wrong_nonce') assert.notEqual(fault.nonce, 'fixture-nonce')
    if (mode === 'missing_sub') assert.equal(fault.sub, undefined)
  }
}
await fetch(`${issuer}/__fixture/mode`, {
  method: 'POST',
  body: new URLSearchParams({ mode: 'valid' }),
})
console.log(
  'OIDC fixture self-test passed: discovery, PKCE, signed claims, userinfo, replay, eight fault modes',
)
