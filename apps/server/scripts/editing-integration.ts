import assert from 'node:assert/strict'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'
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
  const dee = await joinFriend(d, invite, 'Dee')
  const room = await call(a, '/api/rooms', Room, { name: 'Room' })
  const channel = await call(a, '/api/channels', Channel, {
    roomId: room.id,
    kind: 'text',
    name: 'chat',
  })
  const otherChannel = await call(a, '/api/channels', Channel, {
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
    const send = { ...scope.scope, retryId: randomUUID(), body: `Original @Bob ${scope.path}` }
    const original = await call(a, scope.path, scope.schema, send)
    assert.equal(original.revision, '0')
    assert.equal(original.editedAt, null)
    const before = await call(b, '/api/snapshot', Snapshot)
    const edit = {
      ...scope.scope,
      messageId: original.id,
      expectedRevision: '0',
      retryId: randomUUID(),
      body: `Corrected ${scope.path}`,
    }
    for (const body of ['', '   ', 'x'.repeat(8001)])
      assert.equal((await a.call(`${scope.path}/edit`, { ...edit, body })).response.status, 400)
    assert.equal(
      (await a.call(`${scope.path}/edit`, { ...edit, extra: true })).response.status,
      400,
    )
    for (const denied of [b, d]) {
      const existing = await denied.call(`${scope.path}/edit`, edit)
      const missing = await denied.call(`${scope.path}/edit`, { ...edit, messageId: randomUUID() })
      assert.equal(existing.response.status, 404)
      assert.deepEqual(existing.value, missing.value)
    }
    assert.equal(
      (await new Client(server.origin).call(`${scope.path}/edit`, edit)).response.status,
      401,
    )
    for (const user of ['', bob.id])
      assert.equal(
        (await a.call(`${scope.path}/edit`, edit, { 'X-Huddle-User': user })).response.status,
        401,
      )
    if ('channelId' in scope.scope)
      assert.equal(
        (await a.call(`${scope.path}/edit`, { ...edit, channelId: otherChannel.id })).response
          .status,
        404,
      )
    const concurrent = { ...edit, retryId: randomUUID(), body: 'Concurrent edit' }
    const attempts = await Promise.all([
      a.call(`${scope.path}/edit`, edit),
      a.call(`${scope.path}/edit`, concurrent),
    ])
    assert.deepEqual(attempts.map((r) => r.response.status).sort(), [200, 409])
    const winner = attempts.find((r) => r.response.status === 200)
    assert.ok(winner)
    const first = scope.schema.parse(winner.value)
    const secondInput = {
      ...edit,
      retryId: randomUUID(),
      expectedRevision: first.revision,
      body: `Final ${scope.path}`,
    }
    const second = await call(a, `${scope.path}/edit`, scope.schema, secondInput)
    assert.equal(second.cursor, original.cursor)
    assert.equal(second.createdAt, original.createdAt)
    assert.equal(second.retryId, original.retryId)
    assert.ok(BigInt(second.revision) > BigInt(first.revision))
    assert.ok(second.editedAt)
    const firstInput = attempts[0]?.response.status === 200 ? edit : concurrent
    assert.deepEqual(
      await call(a, `${scope.path}/edit`, scope.schema, firstInput),
      first,
      'retry returns its immutable receipt after a later correction',
    )
    assert.equal(
      (await a.call(`${scope.path}/edit`, { ...firstInput, body: 'Changed retry' })).response
        .status,
      409,
    )
    assert.deepEqual(
      await call(a, scope.path, scope.schema, send),
      second,
      'original send retry returns latest canonical message',
    )
    assert.equal((await a.call(scope.path, { ...send, body: second.body })).response.status, 409)
    assert.deepEqual(await call(a, scope.history, scope.schema.array()), [second])
    const after = await call(b, '/api/snapshot', Snapshot)
    assert.deepEqual(
      after.unread,
      before.unread,
      'edits preserve original mentions and unread counts',
    )
    assert.deepEqual(
      after.directs.map((v) => v.unread),
      before.directs.map((v) => v.unread),
    )
    assert.deepEqual(
      after.groups.map((v) => v.unread),
      before.groups.map((v) => v.unread),
    )
    if (scope.path === '/api/direct/messages') assert.deepEqual(after.directs[0]?.latest, second)
    if (scope.path === '/api/group/messages') assert.deepEqual(after.groups[0]?.latest, second)
    await server.stop()
    await server.start()
    assert.deepEqual(
      await call(a, `${scope.path}/edit`, scope.schema, secondInput),
      second,
      'receipt survives restart',
    )
    const later = await call(a, scope.path, scope.schema, {
      ...scope.scope,
      retryId: randomUUID(),
      body: `Later message ${scope.path}`,
    })
    const beforeOlderEdit = await call(b, '/api/snapshot', Snapshot)
    const beforeCalEdit = await call(c, '/api/snapshot', Snapshot)
    const olderEdit = await call(a, `${scope.path}/edit`, scope.schema, {
      ...secondInput,
      expectedRevision: second.revision,
      retryId: randomUUID(),
      body: `@Cal, older corrected again ${scope.path}`,
    })
    const ordered = await call(a, scope.history, scope.schema.array())
    assert.deepEqual(
      ordered.map((m) => m.id),
      [original.id, later.id],
      'editing an older message preserves send ordering',
    )
    const afterOlderEdit = await call(b, '/api/snapshot', Snapshot)
    assert.deepEqual(afterOlderEdit.unread, beforeOlderEdit.unread)
    assert.deepEqual(
      (await call(c, '/api/snapshot', Snapshot)).unread,
      beforeCalEdit.unread,
      'adding a mention to old text does not create a notification',
    )
    if (scope.path === '/api/direct/messages')
      assert.deepEqual(afterOlderEdit.directs[0]?.latest, later)
    if (scope.path === '/api/group/messages')
      assert.deepEqual(afterOlderEdit.groups[0]?.latest, later)
    assert.equal(olderEdit.cursor, original.cursor)
    const outsider = await replay(d)
    if (scope.path !== '/api/messages') {
      for (const secret of [original.id, original.body, second.body])
        assert.ok(!outsider.text.includes(secret), 'private edit is absent from outsider replay')
    }
    const visible = await replay(b)
    assert.ok(
      visible.events.some(
        (e) => 'message' in e && e.kind.endsWith('.edited') && e.message.id === original.id,
      ),
    )
    assert.ok(!visible.text.includes('original_body'))
  }
  const groupMessage = (
    await call(
      a,
      `/api/group/messages?groupId=${aa.groupId}&admission=${aa.admission}`,
      GroupMessage.array(),
    )
  )[0]
  assert.ok(groupMessage)
  await call(a, '/api/group/people', GroupObservation, { ...aa, userIds: [dee.id] })
  const admitted = (await call(d, '/api/snapshot', Snapshot)).groups[0]
  assert.ok(admitted)
  const da = access(admitted, dee.id)
  const pastEdit = {
    ...aa,
    messageId: groupMessage.id,
    expectedRevision: groupMessage.revision,
    retryId: randomUUID(),
    body: 'Corrected history before Dee joined',
  }
  const edited = await call(a, '/api/group/messages/edit', GroupMessage, pastEdit)
  assert.ok(BigInt(edited.cursor) < BigInt(da.admission))
  assert.ok(
    (await replay(d)).events.some(
      (e) => e.kind === 'group.message.edited' && e.message.id === edited.id,
    ),
    'event cursor admits edits to pre-admission history',
  )
  await a.call('/api/group/leave', aa)
  assert.equal(
    (await a.call('/api/group/messages/edit', pastEdit)).response.status,
    404,
    'authorization precedes receipt lookup',
  )
  const ba = access(group, bob.id)
  const rejoined = await call(b, '/api/group/people', GroupObservation, {
    ...ba,
    userIds: [alice.id],
  })
  const newAa = access(rejoined.group, alice.id)
  assert.notEqual(newAa.admission, aa.admission)
  assert.equal((await a.call('/api/group/messages/edit', pastEdit)).response.status, 404)
  assert.equal(
    (await a.call('/api/group/messages/edit', { ...pastEdit, ...newAa })).response.status,
    409,
    'admission participates in retry fingerprint',
  )
  await call(a, '/api/group/messages/edit', GroupMessage, {
    ...pastEdit,
    ...newAa,
    expectedRevision: edited.revision,
    retryId: randomUUID(),
    body: 'Edited after rejoining',
  })
  process.stdout.write(
    'PASS message editing in channels, directs and groups: authorization, validation, stale saves, durable receipts, original send retries, summaries, unchanged mentions and unread, restart, private replay and exact admissions.\n',
  )
} finally {
  await server.stop()
  await database.drop()
}
