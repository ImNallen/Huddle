import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { z } from 'zod'
import { UserId, WorkspaceEvent, WorkspaceId } from '@huddle/contracts'

const adminUrl = z.string().parse(process.env.DATABASE_URL)
const name = `huddle_migration_check_${randomBytes(6).toString('hex')}`
const scratchUrl = new URL(adminUrl)
scratchUrl.pathname = `/${name}`
const admin = new pg.Client({ connectionString: adminUrl })
await admin.connect()
await admin.query(`CREATE DATABASE ${name}`)
let closeDomain = async () => {}
try {
  process.env.DATABASE_URL = scratchUrl.href
  const { auth } = await import('../src/lib/auth')
  const { db } = await import('../src/lib/db')
  const domain = await import('../src/lib/domain')
  closeDomain = () => db.end()
  const { getMigrations } = await import('better-auth/db/migration')
  await (await getMigrations(auth.options)).runMigrations()

  const scratch = new pg.Client({ connectionString: scratchUrl.href })
  await scratch.connect()
  try {
    await scratch.query('BEGIN')
    await scratch.query(
      'CREATE TABLE huddle_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    )
    const migrations = new URL('../migrations/', import.meta.url)
    for (const file of (await readdir(migrations)).filter((file) => file < '006').sort()) {
      await scratch.query(await readFile(new URL(file, migrations), 'utf8'))
      await scratch.query('INSERT INTO huddle_migration(name) VALUES ($1)', [file])
    }
    await scratch.query('COMMIT')

    const owner = UserId.parse(randomUUID())
    const member = UserId.parse(randomUUID())
    const legacy = WorkspaceId.parse(randomUUID())
    const empty = WorkspaceId.parse(randomUUID())
    const general = randomUUID()
    const random = randomUUID()
    const message = {
      id: randomUUID(),
      channelId: general,
      authorId: member,
      authorName: 'Legacy colleague',
      authorAvatar: null,
      retryId: randomUUID(),
      body: 'Written before rooms existed.',
      cursor: '3',
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    for (const [id, userName] of [
      [owner, 'Legacy owner'],
      [member, 'Legacy colleague'],
    ])
      await scratch.query(
        'INSERT INTO "user"(id, name, email, "emailVerified") VALUES ($1, $2, $3, true)',
        [id, userName, `${id}@huddle.test`],
      )
    await scratch.query("INSERT INTO workspace(id, name, cursor) VALUES ($1, 'Legacy', 3)", [
      legacy,
    ])
    await scratch.query("INSERT INTO workspace(id, name) VALUES ($1, 'Empty')", [empty])
    await scratch.query(
      "INSERT INTO membership(workspace_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member'), ($4, $2, 'owner')",
      [legacy, owner, member, empty],
    )
    await scratch.query(
      "INSERT INTO channel(id, workspace_id, name) VALUES ($1, $3, 'general'), ($2, $3, 'random')",
      [general, random, legacy],
    )
    await scratch.query(
      'INSERT INTO message(id, channel_id, author_id, author_name, retry_id, body, cursor, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        message.id,
        general,
        member,
        message.authorName,
        message.retryId,
        message.body,
        message.cursor,
        message.createdAt,
      ],
    )
    const legacyEvents = [
      {
        kind: 'channel.created',
        cursor: '1',
        channel: { id: general, workspaceId: legacy, name: 'general' },
      },
      {
        kind: 'channel.created',
        cursor: '2',
        channel: { id: random, workspaceId: legacy, name: 'random' },
      },
      { kind: 'message.created', cursor: '3', message },
    ]
    for (const event of legacyEvents)
      await scratch.query(
        'INSERT INTO workspace_event(workspace_id, cursor, event) VALUES ($1, $2, $3)',
        [legacy, event.cursor, event],
      )
    assert.equal(
      WorkspaceEvent.safeParse(legacyEvents[0]).success,
      false,
      'a legacy channel.created event must fail the new schema before the backfill',
    )

    const migrate = spawn(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(new URL('./migrate.ts', import.meta.url))],
      { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] },
    )
    let output = ''
    migrate.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
    const [code] = await once(migrate, 'exit')
    assert.equal(code, 0, 'migrate.ts applies 006 to the legacy database')
    assert.match(output, /Huddle migrations applied/)

    const rooms = await scratch.query(
      'SELECT id, workspace_id AS "workspaceId", name FROM room ORDER BY name',
    )
    assert.equal(rooms.rowCount, 1, 'only the workspace with channels gets a room')
    const room = rooms.rows[0]
    assert.deepEqual(room, { id: room.id, workspaceId: legacy, name: 'General' })
    const channels = await scratch.query('SELECT id, room_id FROM channel ORDER BY name')
    assert.deepEqual(channels.rows, [
      { id: general, room_id: room.id },
      { id: random, room_id: room.id },
    ])
    const stored = await scratch.query(
      'SELECT event FROM workspace_event WHERE workspace_id = $1 ORDER BY cursor',
      [legacy],
    )
    const events = stored.rows.map((row) => WorkspaceEvent.parse(row.event))
    assert.deepEqual(
      events.map((event) => (event.kind === 'channel.created' ? event.channel.roomId : event.kind)),
      [room.id, room.id, 'message.created'],
    )
    assert.deepEqual(await domain.replay(owner, legacy, '0'), events)
    const snapshot = await domain.snapshot(owner, legacy)
    assert.deepEqual(snapshot.rooms, [room])
    assert.deepEqual(
      snapshot.channels.map((channel) => [channel.name, channel.roomId]),
      [
        ['general', room.id],
        ['random', room.id],
      ],
    )
    assert.deepEqual(snapshot.unread, [{ channelId: general, count: 1 }])
    assert.equal(snapshot.cursor, '3')
    assert.deepEqual((await domain.snapshot(owner, empty)).rooms, [])
  } finally {
    await scratch.end()
  }
  process.stdout.write(
    'PASS 006 backfills one General room per workspace with channels, assigns its channels, adds roomId to legacy channel.created events that replay through WorkspaceEvent, and serves unread counts on migrated data.\n',
  )
} finally {
  await closeDomain()
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
  await admin.end()
}
