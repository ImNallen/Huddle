import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'

const port = Number(process.env.OIDC_FIXTURE_PORT ?? 3184)
const issuer = `http://127.0.0.1:${port}`
process.env.OIDC_DISCOVERY_URL = `${issuer}/.well-known/openid-configuration`
process.env.OIDC_CLIENT_ID = 'discovery-regression'
process.env.OIDC_CLIENT_SECRET = 'discovery-regression-client'
const { companyUser, providerRequest } = await import('../src/lib/auth-provider')
const { db } = await import('../src/lib/db')
const keys = await generateKeyPair('RS256')
const publicKey = {
  ...(await exportJWK(keys.publicKey)),
  kid: 'regression',
  alg: 'RS256',
  use: 'sig',
}
const token = await new SignJWT({ email: 'discovery@huddle.test', email_verified: true })
  .setProtectedHeader({ alg: 'RS256', kid: publicKey.kid })
  .setIssuer(issuer)
  .setAudience('discovery-regression')
  .setSubject('discovery-owner')
  .setIssuedAt()
  .setExpirationTime('5m')
  .sign(keys.privateKey)
let mode: 'timeout' | 'unavailable' | 'malformed' | 'ready' = 'timeout'
let discoveries = 0
const fixture = createServer((request, response) => {
  if (request.url === '/jwks') {
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ keys: [publicKey] }))
    return
  }
  discoveries += 1
  if (mode === 'timeout') return
  if (mode === 'unavailable') {
    response.writeHead(503).end()
    return
  }
  response.setHeader('Content-Type', 'application/json')
  response.end(
    JSON.stringify(mode === 'malformed' ? { issuer } : { issuer, jwks_uri: `${issuer}/jwks` }),
  )
})
fixture.listen(port, '127.0.0.1')
await once(fixture, 'listening')
async function verify() {
  return providerRequest.run({}, () => companyUser({ idToken: token }))
}
try {
  const begun = Date.now()
  const stalled = await Promise.allSettled([verify(), verify()])
  assert(stalled.every((result) => result.status === 'rejected'))
  assert(Date.now() - begun < 8000, 'Discovery must have a bounded timeout')
  assert.equal(discoveries, 1, 'Concurrent callbacks share one pending discovery request')
  mode = 'unavailable'
  await assert.rejects(verify(), /discovery unavailable/)
  assert.equal(discoveries, 2, 'Timed-out discovery must be retried')
  mode = 'malformed'
  await assert.rejects(verify())
  assert.equal(discoveries, 3, 'HTTP discovery failures must be retried')
  mode = 'ready'
  assert.equal((await verify())?.sub, 'discovery-owner')
  assert.equal(discoveries, 4, 'Malformed discovery must be retried after recovery')
  assert.equal((await verify())?.email, 'discovery@huddle.test')
  assert.equal(discoveries, 4, 'Successful validated discovery remains cached')
  process.stdout.write(
    'PASS real discovery timeout, HTTP and schema failures retry after provider recovery; signed identity verification succeeds and successful metadata stays cached.\n',
  )
} finally {
  fixture.closeAllConnections()
  await new Promise<void>((resolve, reject) =>
    fixture.close((error) => (error ? reject(error) : resolve())),
  )
  await db.end()
}
