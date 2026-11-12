import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import pg from 'pg'
import { Cursor, JoinCode, ServerEvent, UserId } from '@huddle/contracts'
import { migrate, migratedDatabase, scratchDatabase } from './harness'

const database = await scratchDatabase()
let closeDomain = async () => {}
try {
  process.env.DATABASE_URL = database.url
  const { db } = await import('../src/lib/db')
  const domain = await import('../src/lib/domain')
  const { pruneAccess } = await import('../src/lib/access-maintenance')
  closeDomain = async () => {
    // db.end() can resolve before its sockets close, and the forced drop then terminates them.
    db.on('error', () => {})
    await db.end()
  }

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
  const rows = async (query: string, values: unknown[] = []) =>
    (await scratch.query(query, values)).rows
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
      messages:
        'SELECT id, channel_id, author_id, author_name, author_avatar, retry_id, body, cursor, created_at FROM message ORDER BY id',
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
    await applyThrough('012_direct_messages.sql')
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

    const seeded = {
      conversation: randomUUID(),
      photo: randomUUID(),
      session: randomUUID(),
    }
    const [lowPair, highPair] = [owner, colleague].sort((a, b) => (a < b ? -1 : 1))
    const photoAvatar = JSON.stringify({ kind: 'photo', uploadId: seeded.photo })
    for (const [id, username] of [
      [owner, 'legacy-owner'],
      [colleague, 'legacy-colleague'],
    ]) {
      await scratch.query(
        'INSERT INTO login(user_id, username, password_hash) VALUES ($1, $2, $3)',
        [id, username, 'scrypt$16384$8$1$salt$key'],
      )
      await scratch.query('INSERT INTO account_security(user_id) VALUES ($1)', [id])
      await scratch.query(
        `INSERT INTO account(id, "accountId", "providerId", "userId", "updatedAt") VALUES ($1, $2, 'credential', $2, now())`,
        [randomUUID(), id],
      )
    }
    await scratch.query(`INSERT INTO account_photo(id, user_id, bytes) VALUES ($1, $2, '\\x00')`, [
      seeded.photo,
      owner,
    ])
    await scratch.query('UPDATE account_security SET avatar = $2 WHERE user_id = $1', [
      owner,
      photoAvatar,
    ])
    await scratch.query(
      `INSERT INTO session(id, "expiresAt", token, "updatedAt", "userId") VALUES ($1, now() + interval '1 day', 'legacy-token', now(), $2)`,
      [seeded.session, owner],
    )
    await scratch.query(
      `INSERT INTO watch_ticket(hash, session_id, expires_at) VALUES ('legacy-ticket', $1, now() + interval '1 minute')`,
      [seeded.session],
    )
    await scratch.query(
      `INSERT INTO verification(id, identifier, value, "expiresAt") VALUES ($1, 'legacy', 'legacy', now())`,
      [randomUUID()],
    )
    await scratch.query(
      "INSERT INTO join_code(code_hash, sealed_code) VALUES ('legacy-hash', 'legacy-sealed')",
    )
    await scratch.query(
      "INSERT INTO setup_code(code_hash, expires_at) VALUES ('legacy-hash', now() + interval '1 day')",
    )
    await scratch.query("INSERT INTO access_limit(key) VALUES ('legacy-limit')")
    await scratch.query('INSERT INTO direct_conversation(id, user_a, user_b) VALUES ($1, $2, $3)', [
      seeded.conversation,
      lowPair,
      highPair,
    ])
    await scratch.query(
      "INSERT INTO direct_message(id, conversation_id, author_id, author_name, author_avatar, retry_id, body, cursor) VALUES ($1, $2, $3, 'Legacy owner', $4, $5, 'Kept private', 6)",
      [randomUUID(), seeded.conversation, owner, photoAvatar, randomUUID()],
    )
    await scratch.query(
      'INSERT INTO direct_read(user_id, conversation_id, cursor) VALUES ($1, $2, 6)',
      [colleague, seeded.conversation],
    )
    const survivors = {
      users: 'SELECT id, name, "createdAt", "updatedAt" FROM "user" ORDER BY id',
      members: 'SELECT user_id, role, created_at FROM member ORDER BY user_id',
      server: 'SELECT singleton, name, cursor::text, created_at FROM server',
      rooms: 'SELECT * FROM room ORDER BY id',
      channels: 'SELECT * FROM channel ORDER BY id',
      messages:
        'SELECT id, channel_id, author_id, author_name, author_avatar, retry_id, body, cursor, created_at FROM message ORDER BY id',
      mentions: 'SELECT * FROM message_mention ORDER BY message_id, user_id',
      reads: 'SELECT * FROM channel_read ORDER BY user_id, channel_id',
      events: 'SELECT cursor, event, audience FROM event ORDER BY cursor',
      conversations: 'SELECT * FROM direct_conversation ORDER BY id',
      directMessages:
        'SELECT id, conversation_id, author_id, author_name, author_avatar, retry_id, body, cursor, created_at FROM direct_message ORDER BY id',
      directReads: 'SELECT * FROM direct_read ORDER BY user_id, conversation_id',
      security: 'SELECT * FROM account_security ORDER BY user_id',
      photos: 'SELECT * FROM account_photo ORDER BY id',
    }
    const before013 = Object.fromEntries(
      await Promise.all(
        Object.entries(survivors).map(async ([key, query]) => [key, await rows(query)]),
      ),
    )
    await applyThrough('014_group_chat.sql')
    const legacyGroup = randomUUID()
    await scratch.query(
      'INSERT INTO group_conversation(id,name,creator_id,create_retry_id,create_others) VALUES($1,$2,$3,$4,$5)',
      [legacyGroup, 'Legacy group', owner, randomUUID(), []],
    )
    await scratch.query(
      "INSERT INTO group_message(id,group_id,author_id,author_admission,author_name,retry_id,body,cursor) VALUES($1,$2,$3,1,'Legacy owner',$4,'Old group body',1)",
      [randomUUID(), legacyGroup, owner, randomUUID()],
    )
    await applyThrough('015_message_editing.sql')
    for (const [key, query] of Object.entries(survivors)) {
      assert.ok(before013[key].length > 0, `the 013 fixture holds ${key}`)
      assert.deepEqual(await rows(query), before013[key], `013 keeps every ${key} row and ID`)
    }
    for (const table of ['message', 'direct_message', 'group_message']) {
      const migrated = await rows(
        `SELECT body,original_body,revision::text,edited_at FROM ${table}`,
      )
      assert.ok(migrated.length > 0)
      for (const value of migrated) {
        assert.equal(value.original_body, value.body, `${table} backfills original body`)
        assert.equal(value.revision, '0')
        assert.equal(value.edited_at, null)
      }
    }
    assert.deepEqual(
      await rows(
        'SELECT id, tailscale_login, legacy_username FROM "user" ORDER BY legacy_username',
      ),
      [
        { id: colleague, tailscale_login: null, legacy_username: 'legacy-colleague' },
        { id: owner, tailscale_login: null, legacy_username: 'legacy-owner' },
      ],
      'every account waits for a link and keeps its old username as a label',
    )
    assert.deepEqual(
      await rows(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('session', 'account', 'verification', 'login', 'watch_ticket')",
      ),
      [],
      '013 drops every credential table',
    )
    assert.deepEqual(
      await rows(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'user' AND column_name IN ('email', 'emailVerified', 'image')",
      ),
      [],
      '013 drops the placeholder email and the unused profile columns',
    )
    const codes = await rows('SELECT * FROM join_code')
    assert.equal(codes.length, 1, 'a server keeps exactly one join code')
    JoinCode.parse(codes[0].code)
    assert.deepEqual(Object.keys(codes[0]).sort(), ['code', 'singleton'], 'no sealed value is left')
    assert.deepEqual(await rows('SELECT * FROM setup_code'), [], 'a keyed setup code is gone')
    assert.deepEqual(await rows('SELECT * FROM access_limit'), [], 'keyed limits are gone')
    await scratch.query('UPDATE "user" SET tailscale_login = $2 WHERE id = $1', [
      owner,
      'owner@huddle.test',
    ])
    await assert.rejects(
      scratch.query('UPDATE "user" SET tailscale_login = $2 WHERE id = $1', [
        colleague,
        'owner@huddle.test',
      ]),
      /user_tailscale_login_key/,
      'a login belongs to one account',
    )
    await assert.rejects(
      scratch.query(`UPDATE "user" SET tailscale_login = 'ab' WHERE id = $1`, [colleague]),
      /user_tailscale_login_check/,
    )
    await scratch.query('UPDATE "user" SET tailscale_login = NULL WHERE id = $1', [owner])
    await scratch.query('DELETE FROM direct_conversation WHERE id = $1', [seeded.conversation])
    await scratch.query('UPDATE account_security SET avatar = $2 WHERE user_id = $1', [
      owner,
      JSON.stringify({ kind: 'mascot', shape: 'circle', color: 'indigo' }),
    ])
    await scratch.query('DELETE FROM account_photo WHERE id = $1', [seeded.photo])

    const events = stored.map((row) => ServerEvent.parse(row.event))
    assert.deepEqual(
      events.flatMap((event) => (event.kind === 'message.created' ? event.mentions : [])),
      [],
      'a stored message.created event without mentions parses to none',
    )
    assert.deepEqual((await domain.replay(owner, '0')).events, events)
    assert.deepEqual(
      (await domain.replay(colleague, '0')).events,
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
    await scratch.query(
      "INSERT INTO account_photo(id, user_id, bytes, created_at) VALUES ($1, $3, '\\x00', now() - interval '2 days'), ($2, $3, '\\x00', now() - interval '2 days')",
      [keptPhoto, prunedPhoto, owner],
    )
    await scratch.query(
      "INSERT INTO direct_message(id, conversation_id, author_id, author_name, author_avatar, retry_id, body, cursor, original_body) VALUES ($1, $2, $3, 'Legacy owner', $4, $5, 'Private', 6, 'Private')",
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

    const { scanned: seen } = await domain.replay(colleague, '0')
    const hidden = (
      await scratch.query('UPDATE server SET cursor = cursor + 1 RETURNING cursor::text')
    ).rows[0].cursor
    await scratch.query('INSERT INTO event(cursor, event, audience) VALUES ($1, $2, $3)', [
      hidden,
      { kind: 'direct.message.created' },
      ['someone-else'],
    ])
    assert.deepEqual(
      await domain.replay(colleague, seen),
      { events: [], scanned: hidden },
      'a watcher moves past an event it cannot see without receiving it',
    )
    assert.deepEqual(
      await domain.replay(colleague, hidden),
      { events: [], scanned: hidden },
      'a watcher at the head stays there',
    )

    const retainedGroupPhoto = randomUUID(),
      retainedGroup = randomUUID()
    await scratch.query(
      "INSERT INTO account_photo(id,user_id,bytes,created_at) VALUES($1,$2,$3,now()-interval '2 days')",
      [retainedGroupPhoto, owner, Buffer.from('group photo')],
    )
    await scratch.query(
      'INSERT INTO group_conversation(id,name,creator_id,create_retry_id,create_others) VALUES($1,$2,$3,$4,$5)',
      [retainedGroup, 'Former group', owner, randomUUID(), []],
    )
    await scratch.query(
      "INSERT INTO group_message(id,group_id,author_id,author_admission,author_name,author_avatar,retry_id,body,cursor,original_body) VALUES($1,$2,$3,1,'Legacy owner',$4,$5,'Retained',1,'Retained')",
      [
        randomUUID(),
        retainedGroup,
        owner,
        JSON.stringify({ kind: 'photo', uploadId: retainedGroupPhoto }),
        randomUUID(),
      ],
    )
    await pruneAccess()
    assert.equal(
      (await scratch.query('SELECT 1 FROM account_photo WHERE id=$1', [retainedGroupPhoto]))
        .rowCount,
      1,
      'history in a group with no remaining members retains its photo',
    )
    await scratch.query('DELETE FROM group_message WHERE group_id=$1', [retainedGroup])
    await pruneAccess()
    assert.equal(
      (await scratch.query('SELECT 1 FROM account_photo WHERE id=$1', [retainedGroupPhoto]))
        .rowCount,
      0,
      'unreferenced old group photo can be pruned',
    )

    const at = async () =>
      Cursor.parse(
        (await scratch.query('UPDATE server SET cursor = cursor + 1 RETURNING cursor::text'))
          .rows[0]?.cursor,
      )
    const scoped = {
      room: randomUUID(),
      text: randomUUID(),
      voice: randomUUID(),
      message: randomUUID(),
      conversation: randomUUID(),
      direct: randomUUID(),
      group: randomUUID(),
      groupMessage: randomUUID(),
    }
    const pair = [owner, colleague]
    const seededEvents: { event: Record<string, unknown>; audience?: string[]; group?: string }[] =
      []
    const seed = async (
      make: (cursor: string) => Record<string, unknown>,
      audience?: string[],
      group?: string,
    ) => {
      const cursor = await at()
      const event = make(cursor)
      seededEvents.push({ event, audience, group })
      await scratch.query(
        'INSERT INTO event(cursor, event, audience, group_id) VALUES ($1, $2, $3, $4)',
        [cursor, event, audience ?? null, group ?? null],
      )
      return cursor
    }
    const authored = (id: string, cursor: string, body: string) => ({
      id,
      authorId: colleague,
      authorName: 'Legacy colleague',
      authorAvatar: null,
      retryId: randomUUID(),
      body,
      cursor,
      createdAt: '2026-11-01T00:00:00.000Z',
      revision: '0',
      editedAt: null,
    })
    await scratch.query("INSERT INTO room(id, name) VALUES ($1, 'Archive')", [scoped.room])
    await seed((cursor) => ({
      kind: 'room.created',
      cursor,
      room: { id: scoped.room, name: 'Archive' },
    }))
    for (const [id, name, kind] of [
      [scoped.text, 'notes', 'text'],
      [scoped.voice, 'Call', 'voice'],
    ]) {
      await scratch.query('INSERT INTO channel(id, room_id, name, kind) VALUES ($1, $2, $3, $4)', [
        id,
        scoped.room,
        name,
        kind,
      ])
      await seed((cursor) => ({
        kind: 'channel.created',
        cursor,
        channel: { id, roomId: scoped.room, name, kind },
      }))
    }
    const sentAt = await seed((cursor) => ({
      kind: 'message.created',
      cursor,
      mentions: [owner],
      message: {
        ...authored(scoped.message, cursor, '@Legacy owner, scoped'),
        channelId: scoped.text,
      },
    }))
    await scratch.query(
      "INSERT INTO message(id, channel_id, author_id, author_name, retry_id, body, original_body, cursor) VALUES ($1, $2, $3, 'Legacy colleague', $4, 'Scoped, edited', '@Legacy owner, scoped', $5)",
      [scoped.message, scoped.text, colleague, randomUUID(), sentAt],
    )
    await scratch.query('INSERT INTO message_mention(message_id, user_id) VALUES ($1, $2)', [
      scoped.message,
      owner,
    ])
    await scratch.query(
      'INSERT INTO channel_read(user_id, channel_id, cursor) VALUES ($1, $2, $3)',
      [owner, scoped.text, sentAt],
    )
    await seed((cursor) => ({
      kind: 'message.edited',
      cursor,
      message: {
        ...authored(scoped.message, sentAt, 'Scoped, edited'),
        channelId: scoped.text,
        revision: cursor,
      },
    }))
    await scratch.query('INSERT INTO direct_conversation(id, user_a, user_b) VALUES ($1, $2, $3)', [
      scoped.conversation,
      low,
      high,
    ])
    const directAt = await seed(
      (cursor) => ({
        kind: 'direct.message.created',
        cursor,
        participants: pair,
        message: {
          ...authored(scoped.direct, cursor, 'Private'),
          conversationId: scoped.conversation,
        },
      }),
      pair,
    )
    await seed(
      (cursor) => ({
        kind: 'direct.message.edited',
        cursor,
        participants: pair,
        message: {
          ...authored(scoped.direct, directAt, 'Private, edited'),
          conversationId: scoped.conversation,
          revision: cursor,
        },
      }),
      pair,
    )
    await scratch.query(
      'INSERT INTO group_conversation(id,name,creator_id,create_retry_id,create_others) VALUES($1,$2,$3,$4,$5)',
      [scoped.group, 'Scoped group', colleague, randomUUID(), [owner]],
    )
    const admitted = await seed(
      (cursor) => ({
        kind: 'group.changed',
        cursor,
        group: {
          id: scoped.group,
          name: 'Scoped group',
          members: [
            { userId: colleague, admission: cursor },
            { userId: owner, admission: cursor },
          ],
          revision: cursor,
          latest: null,
        },
      }),
      pair,
      scoped.group,
    )
    const groupAt = await seed(
      (cursor) => ({
        kind: 'group.message.created',
        cursor,
        message: { ...authored(scoped.groupMessage, cursor, 'Grouped'), groupId: scoped.group },
      }),
      pair,
      scoped.group,
    )
    await seed(
      (cursor) => ({
        kind: 'group.message.edited',
        cursor,
        message: {
          ...authored(scoped.groupMessage, groupAt, 'Grouped, edited'),
          groupId: scoped.group,
          revision: cursor,
        },
      }),
      pair,
      scoped.group,
    )
    await seed(
      (cursor) => ({ kind: 'group.removed', cursor, groupId: scoped.group, admission: admitted }),
      [owner],
      scoped.group,
    )
    const edit = { messageId: scoped.message, expectedRevision: '0', body: 'edited' }
    for (const request of [
      { kind: 'channel', channelId: scoped.text, ...edit },
      { kind: 'direct', conversationId: scoped.conversation, ...edit },
      { kind: 'group', groupId: scoped.group, admission: admitted, ...edit },
    ])
      await scratch.query(
        'INSERT INTO message_edit_receipt(author_id, retry_id, request, response) VALUES ($1, $2, $3, $4)',
        [colleague, randomUUID(), { ...request, retryId: randomUUID() }, { body: 'edited' }],
      )
    for (const { event } of seededEvents)
      assert.equal(ServerEvent.safeParse(event).success, true, `the ${event.kind} fixture parses`)

    const orphan = await at()
    await scratch.query('INSERT INTO event(cursor, event) VALUES ($1, $2)', [
      orphan,
      { kind: 'channel.created', cursor: orphan, channel: { id: randomUUID(), roomId: studio } },
    ])
    const refusedOrphan = await migrate(database.url)
    assert.notEqual(refusedOrphan.code, 0, '016 refuses an event naming a missing channel')
    assert.match(refusedOrphan.output, /event_channel_id_fkey/)
    assert.deepEqual(
      await rows("SELECT name FROM huddle_migration WHERE name = '016_admin_controls.sql'"),
      [],
    )
    await scratch.query('DELETE FROM event WHERE cursor = $1', [orphan])
    const upgraded = await migrate(database.url)
    assert.equal(upgraded.code, 0, upgraded.output)
    assert.match(upgraded.output, /Huddle migrations applied/)
    const scopes = await rows(
      "SELECT event->>'kind' AS kind, room_id, channel_id FROM event ORDER BY cursor",
    )
    assert.deepEqual(
      scopes,
      [
        { kind: 'channel.created', room_id: roomId, channel_id: general },
        { kind: 'channel.created', room_id: roomId, channel_id: random },
        { kind: 'message.created', room_id: null, channel_id: general },
        { kind: 'room.created', room_id: studio, channel_id: null },
        { kind: 'channel.created', room_id: studio, channel_id: studioGeneral },
        { kind: 'direct.message.created', room_id: null, channel_id: null },
        { kind: 'room.created', room_id: scoped.room, channel_id: null },
        { kind: 'channel.created', room_id: scoped.room, channel_id: scoped.text },
        { kind: 'channel.created', room_id: scoped.room, channel_id: scoped.voice },
        { kind: 'message.created', room_id: null, channel_id: scoped.text },
        { kind: 'message.edited', room_id: null, channel_id: scoped.text },
        { kind: 'direct.message.created', room_id: null, channel_id: null },
        { kind: 'direct.message.edited', room_id: null, channel_id: null },
        { kind: 'group.changed', room_id: null, channel_id: null },
        { kind: 'group.message.created', room_id: null, channel_id: null },
        { kind: 'group.message.edited', room_id: null, channel_id: null },
        { kind: 'group.removed', room_id: null, channel_id: null },
      ],
      '016 scopes room and channel events to their room and channel, and nothing else',
    )
    assert.deepEqual(
      await rows(
        "SELECT request->>'kind' AS kind, channel_id FROM message_edit_receipt ORDER BY request->>'kind'",
      ),
      [
        { kind: 'channel', channel_id: scoped.text },
        { kind: 'direct', channel_id: null },
        { kind: 'group', channel_id: null },
      ],
      '016 scopes channel edit receipts only',
    )
    for (const [event, room, channel, constraint] of [
      [{ kind: 'channel.renamed' }, null, scoped.text, /event_room_scope/],
      [{ kind: 'room.deleted' }, scoped.room, null, /event_room_scope/],
      [{ kind: 'message.created' }, null, null, /event_channel_scope/],
      [{ kind: 'channel.deleted' }, scoped.room, scoped.text, /event_channel_scope/],
    ] as const)
      await assert.rejects(
        scratch.query(
          'INSERT INTO event(cursor, event, room_id, channel_id) VALUES ((SELECT max(cursor) + 1 FROM event), $1, $2, $3)',
          [event, room, channel],
        ),
        constraint,
        `a ${event.kind} event with the wrong scope is refused`,
      )
    await assert.rejects(
      scratch.query(
        "INSERT INTO message_edit_receipt(author_id, retry_id, request, response) VALUES ($1, $2, $3, '{}')",
        [colleague, randomUUID(), { kind: 'channel' }],
      ),
      /receipt_channel_scope/,
      'a channel edit receipt must name its channel',
    )
    const remaining = 'SELECT cursor::text, event FROM event ORDER BY cursor'
    const eventsBeforeDelete = await rows(remaining)
    await scratch.query('DELETE FROM channel WHERE id = $1', [scoped.text])
    assert.deepEqual(
      await rows(remaining),
      eventsBeforeDelete.filter(
        ({ event }) =>
          event.channel?.id !== scoped.text && event.message?.channelId !== scoped.text,
      ),
      'deleting a channel deletes its created, message and edit events and keeps the rest',
    )
    assert.equal(eventsBeforeDelete.length - (await rows(remaining)).length, 3)
    for (const [table, column, id] of [
      ['message', 'channel_id', scoped.text],
      ['channel_read', 'channel_id', scoped.text],
      ['message_mention', 'message_id', scoped.message],
    ])
      assert.deepEqual(
        await rows(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [id]),
        [],
        `deleting a channel deletes its ${table} rows`,
      )
    assert.deepEqual(
      await rows("SELECT request->>'kind' AS kind FROM message_edit_receipt ORDER BY 1"),
      [{ kind: 'direct' }, { kind: 'group' }],
      'deleting a channel deletes its edit receipts',
    )
    await scratch.query('DELETE FROM room WHERE id = $1', [scoped.room])
    assert.deepEqual(
      await rows('SELECT 1 FROM event WHERE strpos(event::text, $1) > 0', [scoped.room]),
      [],
      'deleting a room deletes its created event and every event of its channels',
    )
    assert.equal(
      (await rows('SELECT 1 FROM event WHERE group_id = $1', [scoped.group])).length,
      4,
      'group events survive channel and room deletes',
    )

    const shape = `SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns WHERE table_schema = 'public'
      ORDER BY table_name, column_name`
    const fresh = await migratedDatabase()
    const installed = new pg.Client({ connectionString: fresh.url })
    await installed.connect()
    try {
      assert.deepEqual(
        (await installed.query(shape)).rows,
        await rows(shape),
        'a fresh install from 000 reaches the same shape as an upgrade',
      )
      assert.deepEqual(
        (await installed.query('SELECT * FROM join_code')).rows,
        [],
        'a server that is not set up has no join code',
      )
    } finally {
      await installed.end()
      await fresh.drop()
    }
  } finally {
    await scratch.end()
  }
  process.stdout.write(
    'PASS 006 backfills a General room and roomId on legacy events. 007 refuses two workspaces without creating anything, then migrates one workspace losslessly into server, member and event: rooms, channels, messages, read markers, mentions and events are unchanged except the dropped workspace ids, owner becomes admin, and a second server row is impossible. 011 keeps same-named channels in different rooms, backfills every channel and stored channel.created event to text, requires a kind on every insert. 012 leaves every existing event open to all members, enforces one ordered conversation per pair, photo pruning respects direct messages. 013 keeps every account, role, room, channel, message, read, mention, event, direct message, avatar and photo by ID, leaves every login NULL, keeps old usernames as labels, drops credential tables, and issues a valid join code. 015 backfills original bodies, revision zero and null edit timestamps in channel, direct and group messages. 016 refuses an event naming a missing channel without deleting it, scopes every room and channel event and channel edit receipt, refuses wrong scopes, and deleting a channel or room by SQL removes its events, receipts, messages, mentions and reads by cascade. Snapshot and replay work on the result, and a fresh install from 000 reaches the same shape.\n',
  )
} finally {
  await closeDomain()
  await database.drop()
}
