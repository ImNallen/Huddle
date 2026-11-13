import assert from 'node:assert/strict'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'
import sharp from 'sharp'
import { z } from 'zod'
import {
  Channel,
  Room,
  Message,
  DirectMessage,
  DirectConversation,
  GroupMessage,
  GroupObservation,
  GroupAccess,
  Snapshot,
  EventPage,
  PhotoUpload,
  defaultMascot,
  type GroupConversation,
} from '@huddle/contracts'
import {
  Client,
  migratedDatabase,
  startServer,
  setupFriend,
  joinFriend,
  inviteCode,
  tailscale,
} from './harness'

const database = await migratedDatabase()
const code = randomUUID()
const server = await startServer({
  databaseUrl: database.url,
  port: Number(process.env.EDITING_TEST_PORT ?? 3500),
  env: { SETUP_CODE: code },
}).catch(async (error) => {
  await database.drop()
  throw error
})
async function call<S extends z.ZodType>(
  client: Client,
  path: string,
  schema: S,
  body?: unknown,
): Promise<z.output<S>> {
  const result = await client.call(path, body)
  assert.equal(result.response.status, 200, `${path}: ${JSON.stringify(result.value)}`)
  return schema.parse(result.value)
}
async function replay(client: Client, after = '0') {
  const socket = new WebSocket(server.websocket, {
    origin: server.origin,
    headers: tailscale(z.string().parse(client.login)),
  })
  const frames: string[] = []
  socket.on('message', (raw) => frames.push(raw.toString()))
  try {
    await once(socket, 'open')
    socket.send(JSON.stringify({ kind: 'watch', after }))
    for (let i = 0; i < 100 && !frames.length; i++) await delay(25)
    assert.ok(frames.length)
    await delay(100)
    return {
      text: frames.join('\n'),
      events: frames.flatMap((f) => EventPage.parse(JSON.parse(f)).events),
    }
  } finally {
    socket.terminate()
  }
}
const access = (group: GroupConversation, id: string) =>
  GroupAccess.parse({
    groupId: group.id,
    admission: group.members.find((m) => m.userId === id)?.admission,
  })
try {
  const a = new Client(server.origin, 'edit-a@huddle.test')
  const b = new Client(server.origin, 'edit-b@huddle.test')
  const c = new Client(server.origin, 'edit-c@huddle.test')
  const d = new Client(server.origin, 'edit-d@huddle.test')
  const alice = await setupFriend(a, { code, serverName: 'Editing', name: 'Alice' })
  const invite = await inviteCode(a)
  const bob = await joinFriend(b, invite, 'Bob')
  const cal = await joinFriend(c, invite, 'Cal')
  await joinFriend(d, invite, 'Dee')
  const room = await call(a, '/api/rooms', Room, { name: 'Room' })
  const channel = await call(a, '/api/channels', Channel, {
    roomId: room.id,
    kind: 'text',
    name: 'chat',
  })
  await call(a, '/api/channels', Channel, {
    roomId: room.id,
    kind: 'text',
    name: 'other',
  })
  const direct = await call(a, '/api/direct/conversations', DirectConversation, { userId: bob.id })
  const group = (
    await call(a, '/api/groups', GroupObservation, {
      retryId: randomUUID(),
      name: 'Private edits',
      others: [bob.id, cal.id],
    })
  ).group
  const aa = access(group, alice.id)
  const scopes = [
    {
      path: '/api/messages',
      schema: Message,
      scope: { channelId: channel.id },
      history: `/api/messages?channelId=${channel.id}`,
    },
    {
      path: '/api/direct/messages',
      schema: DirectMessage,
      scope: { conversationId: direct.id },
      history: `/api/direct/messages?conversationId=${direct.id}`,
    },
    {
      path: '/api/group/messages',
      schema: GroupMessage,
      scope: aa,
      history: `/api/group/messages?groupId=${aa.groupId}&admission=${aa.admission}`,
    },
  ]
  for (const scope of scopes) {
    const sent = await call(a, scope.path, scope.schema, {
      ...scope.scope,
      retryId: randomUUID(),
      body: 'Reaction target @Bob',
    })
    const request = {
      ...scope.scope,
      messageId: sent.id,
      emoji: '👍',
      present: true,
      retryId: randomUUID(),
    }
    const path = scope.path + '/reaction'
    const before = await call(b, '/api/snapshot', Snapshot)
    const added = await call(a, path, scope.schema, request)
    assert.equal(added.reactions[0]?.people[0]?.id, alice.id)
    assert.notEqual(added.reactionRevision, '0')
    assert.equal(added.revision, sent.revision)
    assert.equal(added.cursor, sent.cursor)
    const noop = await call(a, path, scope.schema, { ...request, retryId: randomUUID() })
    assert.deepEqual(noop, added, 'desired-state no-op')
    const removed = await call(a, path, scope.schema, {
      ...request,
      present: false,
      retryId: randomUUID(),
    })
    assert.deepEqual(removed.reactions, [])
    assert.ok(BigInt(removed.reactionRevision) > BigInt(added.reactionRevision))
    assert.deepEqual(
      await call(a, path, scope.schema, request),
      added,
      'old retry must not reapply add',
    )
    assert.deepEqual(await call(a, scope.history, scope.schema.array()), [removed])
    assert.equal((await a.call(path, { ...request, present: false })).response.status, 409)
    assert.equal(
      (await a.call(path, { ...request, emoji: 'arbitrary', retryId: randomUUID() })).response
        .status,
      400,
    )
    const otherScope = scope.path.includes('/group/') ? access(group, bob.id) : scope.scope
    await Promise.all(
      [a, b].map((person, i) =>
        call(person, path, scope.schema, {
          ...(i ? otherScope : scope.scope),
          messageId: sent.id,
          emoji: '❤️',
          present: true,
          retryId: randomUUID(),
        }),
      ),
    )
    const current = (await call(a, scope.history, scope.schema.array()))[0]
    assert.equal(current?.reactions[0]?.people.length, 2)
    const edited = await call(a, scope.path + '/edit', scope.schema, {
      ...scope.scope,
      messageId: sent.id,
      expectedRevision: '0',
      retryId: randomUUID(),
      body: 'Edited with reactions',
    })
    assert.deepEqual(edited.reactions, current?.reactions)
    assert.equal(edited.reactionRevision, current?.reactionRevision)
    const originalRetry = await call(a, scope.path, scope.schema, {
      ...scope.scope,
      retryId: sent.retryId,
      body: sent.body,
    })
    assert.deepEqual(originalRetry, edited, 'send retry hydrates both axes')
    const after = await call(b, '/api/snapshot', Snapshot)
    assert.deepEqual(after.unread, before.unread)
    assert.deepEqual(
      after.directs.map((v) => v.unread),
      before.directs.map((v) => v.unread),
    )
    assert.deepEqual(
      after.groups.map((v) => v.unread),
      before.groups.map((v) => v.unread),
    )
    if (scope.path !== '/api/messages') {
      const outsider = await d.call(path, request)
      const absent = await d.call(path, { ...request, messageId: randomUUID() })
      assert.equal(outsider.response.status, 404)
      assert.deepEqual(outsider.value, absent.value)
      assert.ok(!(await replay(d)).text.includes(sent.id))
    }
    await server.stop()
    await server.start()
    assert.deepEqual(
      await call(a, path, scope.schema, request),
      added,
      'receipt survives restart and later edit',
    )
    const events = (await replay(a)).events.filter(
      (e) => e.kind.endsWith('reactions.changed') && 'message' in e && e.message.id === sent.id,
    )
    assert.equal(events.length, 4, 'only state changes emit events')
  }
  for (const scope of scopes) {
    const target = await call(a, scope.path, scope.schema, {
      ...scope.scope,
      retryId: randomUUID(),
      body: 'Photo only in a reaction',
    })
    const bytes = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#446688' },
    })
      .png()
      .toBuffer()
    const form = new FormData()
    form.set('photo', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), 'avatar.png')
    const uploaded = await fetch(server.origin + '/api/account/photo', {
      method: 'POST',
      headers: {
        ...tailscale(z.string().parse(a.login)),
        Origin: server.origin,
        'X-Huddle-User': alice.id,
      },
      body: form,
    })
    assert.equal(uploaded.status, 200)
    const photo = PhotoUpload.parse(await uploaded.json())
    await a.act({
      kind: 'profile.save',
      profile: { name: 'Alice', avatar: { kind: 'photo', uploadId: photo.uploadId } },
    })
    await call(a, scope.path + '/reaction', scope.schema, {
      ...scope.scope,
      messageId: target.id,
      emoji: '✨',
      present: true,
      retryId: randomUUID(),
    })
    await a.act({
      kind: 'profile.save',
      profile: { name: 'Alice', avatar: defaultMascot(alice.id) },
    })
    for (const [person, expected] of [
      [b, 200],
      [d, scope.path === '/api/messages' ? 200 : 400],
    ] as const) {
      const result = await fetch(server.origin + '/api/account/photo/' + photo.uploadId, {
        headers: { ...tailscale(z.string().parse(person.login)), Origin: server.origin },
      })
      assert.equal(result.status, expected, scope.path + ' keeps reaction-only photos private')
    }
  }
  const old = await call(a, '/api/group/messages', GroupMessage, {
    ...aa,
    retryId: randomUUID(),
    body: 'Old group target',
  })
  const request = { ...aa, messageId: old.id, emoji: '😊', present: true, retryId: randomUUID() }
  await call(a, '/api/group/messages/reaction', GroupMessage, request)
  await a.call('/api/group/leave', aa)
  assert.equal((await a.call('/api/group/messages/reaction', request)).response.status, 404)
  const rejoined = await call(b, '/api/group/people', GroupObservation, {
    ...access(group, bob.id),
    userIds: [alice.id],
  })
  const newAa = access(rejoined.group, alice.id)
  assert.equal((await a.call('/api/group/messages/reaction', request)).response.status, 404)
  assert.equal(
    (await a.call('/api/group/messages/reaction', { ...request, ...newAa })).response.status,
    409,
  )
  await call(a, '/api/group/messages/reaction', GroupMessage, {
    ...request,
    ...newAa,
    retryId: randomUUID(),
  })
  const dm = await call(a, '/api/direct/messages', DirectMessage, {
    conversationId: direct.id,
    retryId: randomUUID(),
    body: 'Closed target',
  })
  const dr = {
    conversationId: direct.id,
    messageId: dm.id,
    emoji: '👍',
    present: true,
    retryId: randomUUID(),
  }
  const saved = await call(a, '/api/direct/messages/reaction', DirectMessage, dr)
  await call(a, '/api/members/remove', z.object({}), { userId: bob.id })
  assert.deepEqual(await call(a, '/api/direct/messages/reaction', DirectMessage, dr), saved)
  assert.equal(
    (
      await a.call('/api/direct/messages/reaction', {
        ...dr,
        present: false,
        retryId: randomUUID(),
      })
    ).response.status,
    409,
  )
  const { default: pg } = await import('pg')
  const sql = new pg.Client({ connectionString: database.url })
  await sql.connect()
  try {
    await sql.query('DELETE FROM channel WHERE id=$1', [channel.id])
    for (const table of ['message_reaction', 'message_reaction_receipt', 'event']) {
      const rows = await sql.query(`SELECT * FROM ${table}`)
      assert.ok(!JSON.stringify(rows.rows).includes(channel.id), table + ' SQL cascade')
    }
    assert.equal(
      (
        await a.call('/api/messages/reaction', {
          channelId: channel.id,
          messageId: randomUUID(),
          emoji: '👍',
          present: true,
          retryId: randomUUID(),
        })
      ).response.status,
      404,
    )
    await sql.query('DELETE FROM room WHERE id=$1', [room.id])
  } finally {
    await sql.end()
  }
  process.stdout.write(
    'PASS persistent reactions: all scopes, privacy, independent revisions, no-ops, concurrent actors, durable retries, restart, replay, exact admissions, removed peers and SQL cascades.\n',
  )
} finally {
  await server.stop()
  await database.drop()
}
