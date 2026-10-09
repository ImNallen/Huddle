import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { db } from '../src/lib/db'
import { config } from '../src/lib/config'

try {
  const path = process.argv[2]
  assert(path, 'Supply the synthetic legacy fixture manifest path')
  const fixture = z
    .object({
      userId: z.string(),
      email: z.email(),
      memberships: z.number(),
      messages: z.number(),
      linkedProviders: z.array(z.string()),
    })
    .parse(JSON.parse(await readFile(path, 'utf8')))
  const user = await db.query('SELECT id,"emailVerified" FROM "user" WHERE email=$1', [
    fixture.email,
  ])
  assert.equal(user.rows[0]?.id, fixture.userId)
  if (!process.argv.includes('--verified')) assert.equal(user.rows[0]?.emailVerified, false)
  const links = await db.query(
    'SELECT "providerId",password FROM account WHERE "userId"=$1 ORDER BY "providerId"',
    [fixture.userId],
  )
  assert.deepEqual(
    links.rows.map((row) => row.providerId),
    fixture.linkedProviders.toSorted(),
  )
  assert(
    links.rows
      .filter((row) => row.providerId === 'credential')
      .every((row) => row.password === null),
  )
  const memberships = await db.query(
    'SELECT count(*)::integer count FROM membership WHERE user_id=$1',
    [fixture.userId],
  )
  const messages = await db.query(
    'SELECT count(*)::integer count FROM message WHERE author_id=$1',
    [fixture.userId],
  )
  assert.equal(memberships.rows[0].count, fixture.memberships)
  assert.equal(messages.rows[0].count, fixture.messages)
  const legacy = await db.query(
    'SELECT s.token FROM session s LEFT JOIN session_proof p ON p.session_id=s.id WHERE s."userId"=$1 AND p.session_id IS NULL LIMIT 1',
    [fixture.userId],
  )
  if (legacy.rows[0]) {
    const token = z.string().parse(legacy.rows[0].token)
    for (const path of ['/api/workspaces', '/api/account', '/api/watch-ticket']) {
      const response = await fetch(`${config.SERVER_URL}${path}`, {
        method: path.endsWith('watch-ticket') ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${token}`, Origin: config.SERVER_URL },
      })
      assert.equal(response.status, 401)
    }
  }
  process.stdout.write(
    'PASS migration retains identity/provider links/memberships/messages, clears password hashes and denies unproven legacy sessions.\n',
  )
} finally {
  await db.end()
}
