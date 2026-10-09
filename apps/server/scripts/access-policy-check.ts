import assert from 'node:assert/strict'
import { z } from 'zod'
import { db } from '../src/lib/db'
import { config } from '../src/lib/config'

try {
  assert.equal(config.AUTH_POLICY, 'sso-only')
  const proof =
    await db.query(`SELECT s.token FROM session s JOIN session_proof p ON p.session_id=s.id JOIN account_security a ON a.user_id=p.user_id AND a.epoch=p.epoch JOIN "user" u ON u.id=p.user_id
    WHERE p.method='totp' AND p.stage='ready' AND s."expiresAt">now() AND u.email LIKE 'access-%@huddle.test' ORDER BY s."createdAt" DESC LIMIT 1`)
  const token = z.string().parse(proof.rows[0]?.token)
  for (const path of ['/api/workspaces', '/api/account', '/api/watch-ticket']) {
    const response = await fetch(`${config.SERVER_URL}${path}`, {
      method: path.endsWith('watch-ticket') ? 'POST' : 'GET',
      headers: { Origin: config.SERVER_URL, Authorization: `Bearer ${token}` },
    })
    assert.equal(response.status, 401)
  }
  for (const [path, body] of [
    ['/api/access', { kind: 'email.send', email: 'blocked@huddle.test' }],
    ['/api/access/passkey/authenticate/options', { purpose: 'signin' }],
  ] satisfies [string, object][]) {
    assert.equal(
      (
        await fetch(`${config.SERVER_URL}${path}`, {
          method: 'POST',
          headers: { Origin: config.SERVER_URL, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).status,
      503,
    )
  }
  const view = z
    .object({ stage: z.object({ kind: z.literal('signin'), methods: z.array(z.string()) }) })
    .parse(await (await fetch(`${config.SERVER_URL}/api/access`)).json())
  assert.deepEqual(view.stage.methods, ['company'])
  process.stdout.write(
    'PASS SSO-only denies previously proved synthetic local sessions and local authentication routes.\n',
  )
} finally {
  await db.end()
}
