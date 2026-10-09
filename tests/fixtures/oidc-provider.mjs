import http from 'node:http'
import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto'

const port = Number(process.env.OIDC_FIXTURE_PORT ?? 3174)
const base = process.env.OIDC_FIXTURE_ISSUER ?? `http://127.0.0.1:${port}`
const clientId = process.env.OIDC_FIXTURE_CLIENT_ID ?? 'huddle-test'
const clientSecret = process.env.OIDC_FIXTURE_CLIENT_SECRET ?? 'huddle-test-secret'
let subject = process.env.OIDC_FIXTURE_SUBJECT ?? 'fixture-user-1'
let email = process.env.OIDC_FIXTURE_EMAIL ?? 'oidc-fixture@huddle.test'
const modes = new Set([
  'valid',
  'missing_id_token',
  'wrong_issuer',
  'wrong_audience',
  'missing_email_verified',
  'unverified_email',
  'wrong_nonce',
  'missing_sub',
  'userinfo_subject_mismatch',
])
let mode = 'valid'
const grants = new Map()
const accessTokens = new Map()
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = publicKey.export({ format: 'jwk' })
Object.assign(jwk, { kid: 'fixture-rs256-1', alg: 'RS256', use: 'sig' })

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}
function bad(response, error, status = 400) {
  json(response, status, { error })
}
function redirect(response, url) {
  response.writeHead(302, { location: url, 'cache-control': 'no-store' })
  response.end()
}
function random() {
  return randomBytes(24).toString('base64url')
}
function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}
function idToken(nonce) {
  const now = Math.floor(Date.now() / 1000)
  const claims = {
    iss: mode === 'wrong_issuer' ? `${base}/wrong` : base,
    aud: mode === 'wrong_audience' ? `${clientId}-wrong` : clientId,
    sub: subject,
    email,
    email_verified: mode !== 'unverified_email',
    nonce: mode === 'wrong_nonce' ? `${nonce}-wrong` : nonce,
    iat: now,
    exp: now + 300,
  }
  if (mode === 'missing_email_verified') delete claims.email_verified
  if (mode === 'missing_sub') delete claims.sub
  const head = encode({ alg: 'RS256', typ: 'JWT', kid: jwk.kid })
  const body = encode(claims)
  const signed = `${head}.${body}`
  const signature = createSign('RSA-SHA256')
    .update(signed)
    .end()
    .sign(privateKey)
    .toString('base64url')
  return `${signed}.${signature}`
}
function html(response, text, status = 200) {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(text)
}
function formPage(query) {
  const fields = [
    'client_id',
    'redirect_uri',
    'response_type',
    'scope',
    'state',
    'nonce',
    'code_challenge',
    'code_challenge_method',
  ]
  const safe = (value) =>
    String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
  return `<!doctype html><html><head><title>Huddle fixture IdP</title></head><body><h1>Fixture company sign in</h1><p>Approve synthetic identity ${safe(email)}</p><form method="post" action="/authorize">${fields.map((field) => `<input type="hidden" name="${field}" value="${safe(query.get(field))}">`).join('')}<button type="submit" name="decision" value="approve">Sign in and approve</button><button type="submit" name="decision" value="deny">Deny</button></form></body></html>`
}
function validAuthorize(query) {
  let redirect
  try {
    redirect = new URL(query.get('redirect_uri'))
  } catch {
    return false
  }
  return (
    query.get('client_id') === clientId &&
    query.get('response_type') === 'code' &&
    redirect.protocol === 'http:' &&
    ['127.0.0.1', 'localhost'].includes(redirect.hostname) &&
    query.get('state') &&
    query.get('nonce') &&
    query.get('code_challenge_method') === 'S256' &&
    query.get('code_challenge') &&
    query.get('scope')?.split(' ').includes('openid')
  )
}
async function bodyParams(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 16_384) throw new Error('body_too_large')
    chunks.push(chunk)
  }
  return new URLSearchParams(Buffer.concat(chunks).toString())
}
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, base)
    if (request.method === 'GET' && url.pathname === '/.well-known/openid-configuration')
      return json(response, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        userinfo_endpoint: `${base}/userinfo`,
        jwks_uri: `${base}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        scopes_supported: ['openid', 'profile', 'email'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
        code_challenge_methods_supported: ['S256'],
      })
    if (request.method === 'GET' && url.pathname === '/jwks')
      return json(response, 200, { keys: [jwk] })
    if (request.method === 'POST' && url.pathname === '/__fixture/mode') {
      const params = await bodyParams(request)
      if (!modes.has(params.get('mode'))) return bad(response, 'invalid_mode')
      mode = params.get('mode')
      return json(response, 200, { mode })
    }
    if (request.method === 'GET' && url.pathname === '/__fixture/mode')
      return json(response, 200, { mode })
    if (request.method === 'POST' && url.pathname === '/__fixture/identity') {
      const params = await bodyParams(request)
      if (!params.get('sub') || !params.get('email')) return bad(response, 'invalid_identity')
      subject = params.get('sub')
      email = params.get('email')
      return json(response, 200, { sub: subject, email })
    }
    if (url.pathname === '/authorize' && request.method === 'GET') {
      if (!validAuthorize(url.searchParams)) return bad(response, 'invalid_request')
      return html(response, formPage(url.searchParams))
    }
    if (url.pathname === '/authorize' && request.method === 'POST') {
      const params = await bodyParams(request)
      if (!validAuthorize(params)) return bad(response, 'invalid_request')
      const callback = new URL(params.get('redirect_uri'))
      callback.searchParams.set('state', params.get('state'))
      if (params.get('decision') !== 'approve') callback.searchParams.set('error', 'access_denied')
      else {
        const code = random()
        grants.set(code, {
          clientId,
          redirectUri: params.get('redirect_uri'),
          nonce: params.get('nonce'),
          challenge: params.get('code_challenge'),
          expires: Date.now() + 60_000,
        })
        callback.searchParams.set('code', code)
      }
      return redirect(response, callback)
    }
    if (request.method === 'POST' && url.pathname === '/token') {
      const params = await bodyParams(request)
      const basic = request.headers.authorization?.startsWith('Basic ')
        ? Buffer.from(request.headers.authorization.slice(6), 'base64').toString().split(':')
        : []
      const authId = params.get('client_id') ?? basic[0]
      const authSecret = params.get('client_secret') ?? basic[1]
      const grant = grants.get(params.get('code'))
      if (
        params.get('grant_type') !== 'authorization_code' ||
        authId !== clientId ||
        authSecret !== clientSecret ||
        !grant ||
        grant.expires < Date.now() ||
        grant.redirectUri !== params.get('redirect_uri')
      )
        return bad(response, 'invalid_grant')
      const challenge = createHash('sha256')
        .update(params.get('code_verifier') ?? '')
        .digest('base64url')
      if (challenge !== grant.challenge) return bad(response, 'invalid_grant')
      grants.delete(params.get('code'))
      const accessToken = random()
      accessTokens.set(accessToken, Date.now() + 300_000)
      const tokens = {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 300,
        scope: 'openid profile email',
      }
      if (mode !== 'missing_id_token') tokens.id_token = idToken(grant.nonce)
      return json(response, 200, tokens)
    }
    if (request.method === 'GET' && url.pathname === '/userinfo') {
      const token = request.headers.authorization?.replace(/^Bearer /, '')
      if (!token || (accessTokens.get(token) ?? 0) < Date.now())
        return bad(response, 'invalid_token', 401)
      const user = {
        sub: mode === 'userinfo_subject_mismatch' ? `${subject}-wrong` : subject,
        email,
        name: 'Fixture User',
        email_verified: mode !== 'unverified_email',
      }
      if (mode === 'missing_email_verified') delete user.email_verified
      return json(response, 200, user)
    }
    return bad(response, 'not_found', 404)
  } catch (error) {
    return bad(response, error.message === 'body_too_large' ? 'body_too_large' : 'invalid_request')
  }
})
server.listen(port, '127.0.0.1', () => process.stdout.write(`Fixture OIDC provider ${base}\n`))
