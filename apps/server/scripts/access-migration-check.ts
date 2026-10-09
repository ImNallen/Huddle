import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import pg from 'pg'
import { z } from 'zod'
import { Message, ServerInfo, Snapshot } from '@huddle/contracts'
import { Client, join, migrate, scratchDatabase, startServer, type ServerProcess } from './harness'

const database = await scratchDatabase()
let server: ServerProcess | undefined
const scratch = new pg.Client({ connectionString: database.url })
try {
  process.env.DATABASE_URL = database.url
  const { auth } = await import('../src/lib/auth')
  const { db } = await import('../src/lib/db')
  const { getMigrations } = await import('better-auth/db/migration')
  await (await getMigrations(auth.options)).runMigrations()
  await db.end()

  await scratch.connect()
  await scratch.query('BEGIN')
  await scratch.query(
    'CREATE TABLE huddle_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  )
  const migrations = new URL('../migrations/', import.meta.url)
  for (const file of (await readdir(migrations))
    .filter((file) => file <= '002_watch_ticket.sql')
    .sort()) {
    await scratch.query(await readFile(new URL(file, migrations), 'utf8'))
    await scratch.query('INSERT INTO huddle_migration(name) VALUES ($1)', [file])
  }
  await scratch.query('COMMIT')

  const userId = randomUUID()
  const email = `legacy-${randomUUID()}@huddle.test`
  const legacy = randomUUID()
  const channels = [randomUUID(), randomUUID()]
  const legacyToken = randomBytes(24).toString('base64url')
  await scratch.query(
    'INSERT INTO "user"(id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1, $2, $3, false, now(), now())',
    [userId, 'Legacy owner', email],
  )
  await scratch.query(
    `INSERT INTO account(id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt") VALUES
    ($1, $2, 'credential', $2, 'legacy-password-hash', now(), now()),
    ($3, $4, 'company', $2, NULL, now(), now())`,
    [randomUUID(), userId, randomUUID(), `legacy-subject-${randomUUID()}`],
  )
  await scratch.query(
    `INSERT INTO session(id, token, "userId", "expiresAt", "createdAt", "updatedAt") VALUES ($1, $2, $3, now() + interval '7 days', now(), now())`,
    [randomUUID(), legacyToken, userId],
  )
  await scratch.query("INSERT INTO workspace(id, name, cursor) VALUES ($1, 'Legacy', 5)", [legacy])
  await scratch.query(
    "INSERT INTO membership(workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
    [legacy, userId],
  )
  await scratch.query(
    "INSERT INTO channel(id, workspace_id, name) VALUES ($1, $3, 'general'), ($2, $3, 'random')",
    [...channels, legacy],
  )
  const messages = [channels[0], channels[0], channels[1]]
  for (const [index, channel] of messages.entries())
    await scratch.query(
      'INSERT INTO message(id, channel_id, author_id, author_name, retry_id, body, cursor) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [randomUUID(), channel, userId, 'Legacy owner', randomUUID(), `Legacy ${index}`, index + 3],
    )

  const migrated = await migrate(database.url)
  assert.equal(migrated.code, 0, migrated.output)
  const user = await scratch.query('SELECT id, "emailVerified" FROM "user" WHERE email = $1', [
    email,
  ])
  assert.deepEqual(
    user.rows,
    [{ id: userId, emailVerified: false }],
    'the legacy identity keeps its ID and stays unverified until an email proof',
  )
  const links = await scratch.query(
    'SELECT "providerId", password FROM account WHERE "userId" = $1 ORDER BY "providerId"',
    [userId],
  )
  assert.deepEqual(
    links.rows,
    [
      { providerId: 'company', password: null },
      { providerId: 'credential', password: null },
    ],
    'provider links survive and password hashes are cleared',
  )
  const member = await scratch.query('SELECT role FROM member WHERE user_id = $1', [userId])
  assert.deepEqual(member.rows, [{ role: 'admin' }], 'the legacy owner becomes the admin')
  const stored = await scratch.query(
    'SELECT count(*)::integer AS count FROM message WHERE author_id = $1',
    [userId],
  )
  assert.equal(stored.rows[0].count, messages.length, 'legacy messages survive the migration')

  server = await startServer({
    databaseUrl: database.url,
    port: 3340,
    entry: 'scripts/access-test-server.ts',
    env: { SETUP_CODE: `migration-${randomUUID()}` },
  })
  const info = ServerInfo.parse(await (await fetch(`${server.origin}/api/info`)).json())
  assert.deepEqual(
    [info.name, info.setup],
    ['Legacy', 'complete'],
    'the single legacy workspace becomes the onboarded server',
  )
  const unproven = new Client(server.origin)
  unproven.token = legacyToken
  for (const [path, body] of [
    ['/api/snapshot', undefined],
    ['/api/account', undefined],
    ['/api/watch-ticket', {}],
  ] as const)
    assert.equal(
      (await unproven.call(path, body)).response.status,
      401,
      `the unproven legacy session is denied at ${path}`,
    )

  const client = new Client(server.origin)
  const identity = await join(client, email, 'Legacy owner')
  assert.equal(identity.user.id, userId, 'email sign-in reuses the legacy user ID')
  const proved = await scratch.query(
    'SELECT s.token FROM session s JOIN session_proof p ON p.session_id = s.id WHERE s."userId" = $1',
    [userId],
  )
  const fresh = new Client(server.origin)
  fresh.token = z.string().parse(proved.rows[0]?.token)
  const snapshot = Snapshot.parse((await fresh.call('/api/snapshot')).value)
  assert.equal(snapshot.server.name, 'Legacy', 'the proved raw bearer reads the server')
  assert.equal(snapshot.server.role, 'admin')
  let read = 0
  for (const channel of snapshot.channels) {
    const history = await client.call(`/api/messages?channelId=${channel.id}`)
    assert.equal(history.response.status, 200, JSON.stringify(history.value))
    read += Message.array().parse(history.value).length
  }
  assert.equal(read, messages.length, 'legacy messages are readable after email onboarding')
  process.stdout.write(
    'PASS migration retains identity, provider links, the owner as admin and messages, clears password hashes, denies unproven legacy sessions, and lets the legacy owner reach the same data through email sign-in.\n',
  )
} finally {
  await server?.stop()
  await scratch.end().catch(() => undefined)
  await database.drop()
}
