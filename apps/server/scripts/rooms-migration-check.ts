import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import pg from 'pg'
import { ServerEvent, UserId } from '@huddle/contracts'
import { migrate, scratchDatabase } from './harness'

const database = await scratchDatabase()
let closeDomain = async () => {}
try {
  process.env.DATABASE_URL = database.url
  const { auth } = await import('../src/lib/auth')
  const { db } = await import('../src/lib/db')
  const domain = await import('../src/lib/domain')
  const { pruneAccess } = await import('../src/lib/access-maintenance')
  closeDomain = () => db.end()
  const { getMigrations } = await import('better-auth/db/migration')
  await (await getMigrations(auth.options)).runMigrations()

  const scratch = new pg.Client({ connectionString: database.url })
  await scratch.connect()
  const migrations = new URL('../migrations/', import.meta.url)
  async function applyThrough(last: string) {
    await scratch.query('BEGIN')
    await scratch.query(
      'CREATE TABLE IF NOT EXISTS huddle_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    )
    const applied = await scratch.query('SELECT name FROM huddle_migration')
    const done = new Set(applied.rows.map((row) => row.name))
    for (const file of (await readdir(migrations)).filter((file) => file <= last).sort()) {
      if (done.has(file)) continue
      await scratch.query(await readFile(new URL(file, migrations), 'utf8'))
      await scratch.query('INSERT INTO huddle_migration(name) VALUES ($1)', [file])
    }
    await scratch.query('COMMIT')
  }
  const rows = async (query: string) => (await scratch.query(query)).rows
  try {
    await applyThrough('005_recovery_acknowledgement.sql')
    const owner = UserId.parse(randomUUID())
    const colleague = UserId.parse(randomUUID())
    const legacy = randomUUID()
    const empty = randomUUID()
    const general = randomUUID()
    const random = randomUUID()
    const message = {
      id: randomUUID(),
      channelId: general,
      authorId: colleague,
      authorName: 'Legacy colleague',
      authorAvatar: null,
      retryId: randomUUID(),
      body: '@Legacy owner, written before rooms existed.',
      cursor: '3',
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    for (const [id, name] of [
      [owner, 'Legacy owner'],
      [colleague, 'Legacy colleague'],
    ])
      await scratch.query(
        'INSERT INTO "user"(id, name, email, "emailVerified") VALUES ($1, $2, $3, true)',
        [id, name, `${id}@huddle.test`],
      )
    await scratch.query("INSERT INTO workspace(id, name, cursor) VALUES ($1, 'Legacy', 3)", [
      legacy,
    ])
    await scratch.query("INSERT INTO workspace(id, name) VALUES ($1, 'Empty')", [empty])
    await scratch.query(
      "INSERT INTO membership(workspace_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member'), ($4, $2, 'owner')",
      [legacy, owner, colleague, empty],
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
        colleague,
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
      ServerEvent.safeParse(legacyEvents[0]).success,
      false,
      'a pre-room channel.created event fails the current schema before the 006 backfill',
    )

    await applyThrough('006_rooms_and_reads.sql')
    const backfilled = await rows('SELECT id, workspace_id, name FROM room ORDER BY name')
    assert.equal(backfilled.length, 1, '006 gives only the workspace with channels a room')
    const roomId = backfilled[0].id
    assert.deepEqual(backfilled, [{ id: roomId, workspace_id: legacy, name: 'General' }])
    await scratch.query(
      'INSERT INTO channel_read(user_id, channel_id, cursor) VALUES ($1, $2, 2)',
      [owner, general],
    )
    await scratch.query('INSERT INTO message_mention(message_id, user_id) VALUES ($1, $2)', [
      message.id,
      owner,
    ])
    const studio = randomUUID()
    const studioGeneral = randomUUID()
    await scratch.query("INSERT INTO room(id, workspace_id, name) VALUES ($1, $2, 'Studio')", [
      studio,
      legacy,
    ])
    await scratch.query(
      "INSERT INTO channel(id, workspace_id, room_id, name) VALUES ($1, $2, $3, 'general')",
      [studioGeneral, legacy, studio],
    )
    await scratch.query('UPDATE workspace SET cursor = 5 WHERE id = $1', [legacy])
    for (const event of [
      {
        kind: 'room.created',
        cursor: '4',
        room: { id: studio, workspaceId: legacy, name: 'Studio' },
      },
      {
        kind: 'channel.created',
        cursor: '5',
        channel: { id: studioGeneral, workspaceId: legacy, roomId: studio, name: 'general' },
      },
    ])
      await scratch.query(
        'INSERT INTO workspace_event(workspace_id, cursor, event) VALUES ($1, $2, $3)',
        [legacy, event.cursor, event],
      )

    const kept = {
      rooms: 'SELECT id, name FROM room ORDER BY id',
      channels: 'SELECT id, room_id, name FROM channel ORDER BY id',
      messages: 'SELECT * FROM message ORDER BY id',
      reads: 'SELECT * FROM channel_read ORDER BY user_id, channel_id',
      mentions: 'SELECT * FROM message_mention ORDER BY message_id, user_id',
    }
    const before = Object.fromEntries(
      await Promise.all(Object.entries(kept).map(async ([key, query]) => [key, await rows(query)])),
    )
    const eventsBefore = await rows(
      "SELECT cursor::text, event #- '{room,workspaceId}' #- '{channel,workspaceId}' AS event FROM workspace_event ORDER BY cursor",
    )

    const refused = await migrate(database.url)
    assert.notEqual(refused.code, 0, 'migrate.ts refuses a database with two workspaces')
    assert.match(
      refused.output,
      /This database has 2 workspaces, but a Huddle server now holds exactly one/,
    )
    assert.match(refused.output, /Reset it: drop and recreate the database/)
    assert.deepEqual(
      await rows("SELECT name FROM huddle_migration WHERE name = '007_single_server.sql'"),
      [],
      'the refused migration is not recorded',
    )
    assert.deepEqual(
      await rows(
        "SELECT table_name FROM information_schema.tables WHERE table_name IN ('server', 'member', 'event', 'setup_code')",
      ),
      [],
      'the refused migration creates none of its tables',
    )
    assert.equal((await rows("SELECT 1 FROM membership WHERE role = 'owner'")).length, 2)

    await scratch.query('DELETE FROM workspace WHERE id = $1', [empty])
    await applyThrough('010_session_rows.sql')
    assert.deepEqual(await rows('SELECT singleton, name, cursor::text FROM server'), [
      { singleton: true, name: 'Legacy', cursor: '5' },
    ])
    assert.deepEqual(await rows('SELECT user_id, role FROM member ORDER BY role'), [
      { user_id: owner, role: 'admin' },
      { user_id: colleague, role: 'member' },
    ])
    for (const [key, query] of Object.entries(kept))
      assert.deepEqual(await rows(query), before[key], `007 keeps every ${key} row`)
    assert.deepEqual(
      await rows('SELECT cursor::text, event FROM event ORDER BY cursor'),
      eventsBefore,
      '007 keeps every event and only drops the legacy workspaceId fields',
    )
    assert.deepEqual(
      await rows(
        "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND (column_name = 'workspace_id' OR table_name IN ('workspace', 'membership', 'workspace_event'))",
      ),
      [],
      'no workspace table or workspace_id column survives',
    )
    await assert.rejects(
      scratch.query("INSERT INTO server(name) VALUES ('Second')"),
      /server_pkey/,
      'a second server row is impossible',
    )
    await assert.rejects(
      scratch.query("UPDATE member SET role = 'owner' WHERE user_id = $1", [colleague]),
      /member_role_check/,
    )
    await assert.rejects(
      scratch.query("INSERT INTO room(id, name) VALUES ($1, 'GENERAL')", [randomUUID()]),
      /room_name/,
      'room names stay unique on the server, ignoring case',
    )

    assert.equal(
      ServerEvent.safeParse(eventsBefore[0].event).success,
      false,
      'a channel.created event without a kind fails the current schema before 011',
    )
    const accepted = await migrate(database.url)
    assert.equal(accepted.code, 0, accepted.output)
    assert.match(accepted.output, /Huddle migrations applied/)
    assert.deepEqual(
      await rows('SELECT id, room_id, name FROM channel ORDER BY id'),
      before.channels,
      '011 keeps every channel in its room, including same-named channels in different rooms',
    )
    assert.deepEqual(
      await rows(
        'SELECT r.name AS room, c.name, c.kind FROM channel c JOIN room r ON r.id = c.room_id ORDER BY r.name, c.name',
      ),
      [
        { room: 'General', name: 'general', kind: 'text' },
        { room: 'General', name: 'random', kind: 'text' },
        { room: 'Studio', name: 'general', kind: 'text' },
      ],
      '011 backfills existing channels to text',
    )
    assert.deepEqual(
      await rows(
        "SELECT is_nullable, column_default FROM information_schema.columns WHERE table_name = 'channel' AND column_name = 'kind'",
      ),
      [{ is_nullable: 'NO', column_default: null }],
      'every insert must state its kind',
    )
    await assert.rejects(
      scratch.query("INSERT INTO channel(id, room_id, name) VALUES ($1, $2, 'nokind')", [
        randomUUID(),
        studio,
      ]),
      /null value in column "kind"/,
    )
    await assert.rejects(
      scratch.query(
        "INSERT INTO channel(id, room_id, name, kind) VALUES ($1, $2, 'cam', 'video')",
        [randomUUID(), studio],
      ),
      /channel_kind_check/,
    )
    await assert.rejects(
      scratch.query(
        "INSERT INTO channel(id, room_id, name, kind) VALUES ($1, $2, 'general', 'voice')",
        [randomUUID(), studio],
      ),
      /channel_room_id_name_key/,
      'text and voice channels share one namespace in a room',
    )
    const stored = await rows('SELECT cursor::text, event FROM event ORDER BY cursor')
    assert.deepEqual(
      stored,
      eventsBefore.map(({ cursor, event }) => ({
        cursor,
        event:
          event.kind === 'channel.created'
            ? { ...event, channel: { ...event.channel, kind: 'text' } }
            : event,
      })),
      '011 adds kind to stored channel.created JSON and changes nothing else',
    )
    assert.deepEqual(
      stored
        .filter(({ event }) => event.kind === 'channel.created')
        .map(({ event }) => event.channel.kind),
      ['text', 'text', 'text'],
    )

    assert.deepEqual(
      await rows('SELECT DISTINCT audience FROM event'),
      [{ audience: null }],
      '012 leaves every existing event open to every member',
    )
    const events = stored.map((row) => ServerEvent.parse(row.event))
    assert.deepEqual(
      events.flatMap((event) => (event.kind === 'message.created' ? event.mentions : [])),
      [],
      'a stored message.created event without mentions parses to none',
    )
    assert.deepEqual(await domain.replay(owner, '0'), events)
    assert.deepEqual(
      await domain.replay(colleague, '0'),
      events,
      'after 012 existing events stay visible to everyone',
    )
    const { low, high } = (
      await scratch.query(
        'SELECT LEAST($1::text, $2::text) AS low, GREATEST($1::text, $2::text) AS high',
        [owner, colleague],
      )
    ).rows[0]
    const conversation = randomUUID()
    await assert.rejects(
      scratch.query('INSERT INTO direct_conversation(id, user_a, user_b) VALUES ($1, $2, $3)', [
        randomUUID(),
        high,
        low,
      ]),
      /direct_conversation_check/,
      'a conversation stores its pair in one order',
    )
    await assert.rejects(
      scratch.query('INSERT INTO direct_conversation(id, user_a, user_b) VALUES ($1, $2, $2)', [
        randomUUID(),
        owner,
      ]),
      /direct_conversation_check/,
      'nobody has a conversation with themselves',
    )
    await scratch.query('INSERT INTO direct_conversation(id, user_a, user_b) VALUES ($1, $2, $3)', [
      conversation,
      low,
      high,
    ])
    await assert.rejects(
      scratch.query('INSERT INTO direct_conversation(id, user_a, user_b) VALUES ($1, $2, $3)', [
        randomUUID(),
        low,
        high,
      ]),
      /direct_conversation_user_a_user_b_key/,
      'a pair has one conversation',
    )
    const [keptPhoto, prunedPhoto] = [randomUUID(), randomUUID()]
    await scratch.query('INSERT INTO account_security(user_id) VALUES ($1)', [owner])
    await scratch.query(
      "INSERT INTO account_photo(id, user_id, bytes, created_at) VALUES ($1, $3, '\\x00', now() - interval '2 days'), ($2, $3, '\\x00', now() - interval '2 days')",
      [keptPhoto, prunedPhoto, owner],
    )
    await scratch.query(
      "INSERT INTO direct_message(id, conversation_id, author_id, author_name, author_avatar, retry_id, body, cursor) VALUES ($1, $2, $3, 'Legacy owner', $4, $5, 'Private', 6)",
      [
        randomUUID(),
        conversation,
        owner,
        JSON.stringify({ kind: 'photo', uploadId: keptPhoto }),
        randomUUID(),
      ],
    )
    await pruneAccess()
    assert.deepEqual(
      await rows('SELECT id FROM account_photo ORDER BY id'),
      [{ id: keptPhoto }],
      'pruning keeps a photo a direct message still shows and drops an unreferenced one',
    )
    await scratch.query('DELETE FROM direct_conversation WHERE id = $1', [conversation])
    const snapshot = await domain.snapshot(owner)
    assert.deepEqual(snapshot.server, {
      name: 'Legacy',
      role: 'admin',
      memberCount: 2,
      channelCount: 3,
    })
    assert.deepEqual(snapshot.rooms, [
      { id: roomId, name: 'General' },
      { id: studio, name: 'Studio' },
    ])
    assert.deepEqual(
      snapshot.channels
        .map((channel) => [channel.name, channel.roomId, channel.kind])
        .sort((a, b) => `${a[0]}${a[1]}`.localeCompare(`${b[0]}${b[1]}`)),
      [
        ['general', roomId, 'text'],
        ['general', studio, 'text'],
        ['random', roomId, 'text'],
      ].sort((a, b) => `${a[0]}${a[1]}`.localeCompare(`${b[0]}${b[1]}`)),
    )
    assert.deepEqual(
      snapshot.unread,
      [{ channelId: general, count: 1, mentions: 1 }],
      'the migrated read marker and mention still drive unread counts',
    )
    assert.deepEqual(snapshot.directs, [])
    assert.equal(snapshot.cursor, '5')
    assert.equal((await domain.snapshot(colleague)).server.role, 'member')
  } finally {
    await scratch.end()
  }
  process.stdout.write(
    'PASS 006 backfills a General room and roomId on legacy events. 007 refuses two workspaces without creating anything, then migrates one workspace losslessly into server, member and event: rooms, channels, messages, read markers, mentions and events are unchanged except the dropped workspace ids, owner becomes admin, and a second server row is impossible. 011 keeps same-named channels in different rooms, backfills every channel and stored channel.created event to text, requires a kind on every insert. 012 leaves every existing event open to all members, enforces one ordered conversation per pair, photo pruning respects direct messages, and snapshot and replay work on the result.\n',
  )
} finally {
  await closeDomain()
  await database.drop()
}
