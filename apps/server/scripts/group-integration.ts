import assert from 'node:assert/strict'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { z } from 'zod'
import sharp from 'sharp'
import {
  Admission,
  GroupObservation,
  GroupMessage,
  GroupRemoval,
  EventPage,
  Snapshot,
  PhotoUpload,
  defaultMascot,
  type GroupConversation,
  type UserId,
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
  port: Number(process.env.GROUP_TEST_PORT ?? 3300),
  env: { SETUP_CODE: code },
}).catch(async (error) => {
  await database.drop()
  throw error
})
const sockets = new Set<WebSocket>()
async function call<T>(client: Client, path: string, schema: z.ZodType<T>, body?: unknown) {
  const { response, value } = await client.call(path, body)
  assert.equal(response.status, 200, `${path}: ${JSON.stringify(value)}`)
  return schema.parse(value)
}
const access = (group: GroupConversation, id: UserId) => ({
  groupId: group.id,
  admission: group.members.find((m) => m.userId === id)?.admission,
})
async function replay(client: Client, after = '0') {
  const socket = new WebSocket(server.websocket, {
    origin: server.origin,
    headers: tailscale(z.string().parse(client.login)),
  })
  sockets.add(socket)
  const frames: string[] = []
  socket.on('message', (raw) => frames.push(raw.toString()))
  await once(socket, 'open')
  socket.send(JSON.stringify({ kind: 'watch', after }))
  for (let i = 0; i < 100 && !frames.length; i++) await delay(25)
  assert.ok(frames.length, 'received replay page')
  await delay(100)
  socket.terminate()
  sockets.delete(socket)
  return {
    text: frames.join('\n'),
    events: frames.flatMap((frame) => EventPage.parse(JSON.parse(frame)).events),
  }
}
try {
  const a = new Client(server.origin, 'group-a@huddle.test')
  const b = new Client(server.origin, 'group-b@huddle.test')
  const c = new Client(server.origin, 'group-c@huddle.test')
  const d = new Client(server.origin, 'group-d@huddle.test')
  const alice = await setupFriend(a, { code, serverName: 'Groups', name: 'Alice' })
  const invite = await inviteCode(a)
  const bob = await joinFriend(b, invite, 'Bob'),
    cal = await joinFriend(c, invite, 'Cal'),
    dee = await joinFriend(d, invite, 'Dee')
  const input = { name: 'Weekend plans', retryId: randomUUID(), others: [bob.id, cal.id] }
  const created = await call(a, '/api/groups', GroupObservation, input)
  const group = created.group,
    aa = access(group, alice.id),
    ba = access(group, bob.id)
  assert.equal(group.members.length, 3)
  assert.equal(group.latest, null)
  assert.equal((await call(b, '/api/snapshot', Snapshot)).groups[0]?.id, group.id)
  assert.deepEqual((await call(d, '/api/snapshot', Snapshot)).groups, [])
  assert.equal(
    (await call(a, '/api/groups', GroupObservation, { ...input, others: [cal.id, bob.id] })).group
      .id,
    group.id,
  )
  assert.equal((await a.call('/api/groups', { ...input, name: 'Changed' })).response.status, 409)
  for (const others of [[bob.id], [bob.id, bob.id], [alice.id, bob.id], [bob.id, 'not-a-member']])
    assert.equal(
      (await a.call('/api/groups', { ...input, retryId: randomUUID(), others })).response.status,
      400,
    )
  const duplicateName = await call(a, '/api/groups', GroupObservation, {
    ...input,
    retryId: randomUUID(),
  })
  assert.notEqual(duplicateName.group.id, group.id)
  const send = { ...aa, retryId: randomUUID(), body: `Private ${randomUUID()}` }
  const message = await call(a, '/api/group/messages', GroupMessage, send)
  assert.deepEqual(await call(a, '/api/group/messages', GroupMessage, send), message)
  const conflict = await a.call('/api/group/messages', { ...send, body: 'changed' })
  assert.equal(conflict.response.status, 409)
  assert.ok(!JSON.stringify(conflict.value).includes(message.body))
  const path = (grant: ReturnType<typeof access>) =>
    `/api/group/messages?groupId=${grant.groupId}&admission=${grant.admission}`
  const random = { ...aa, groupId: randomUUID() }
  for (const [endpoint, payload] of [
    ['/api/group/messages', { ...aa, retryId: randomUUID(), body: 'x' }],
    ['/api/group/read', { ...aa, cursor: message.cursor }],
    ['/api/group/people', { ...aa, userIds: [dee.id] }],
    ['/api/group/leave', aa],
  ] as const) {
    const denied = await d.call(endpoint, payload),
      unknown = await d.call(endpoint, { ...payload, groupId: random.groupId })
    assert.equal(denied.response.status, 404)
    assert.deepEqual(denied.value, unknown.value)
  }
  assert.equal((await d.call(path(aa))).response.status, 404)
  assert.equal(
    (await d.call(path({ ...aa, admission: Admission.parse('9999999999999999999') }))).response
      .status,
    404,
  )
  const hidden = await replay(d)
  for (const secret of [group.id, group.name, message.body, duplicateName.group.id])
    assert.ok(!hidden.text.includes(secret), 'outsider replay contains no group data')
  assert.ok(
    (await replay(b)).events.some(
      (e) => e.kind === 'group.message.created' && e.message.id === message.id,
    ),
  )
  // A photo no longer used by the profile remains private history, accessible to current members.
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#446688' } })
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
  await call(a, '/api/group/messages', GroupMessage, {
    ...aa,
    retryId: randomUUID(),
    body: 'Photo in private history',
  })
  await a.act({ kind: 'profile.save', profile: { name: 'Alice', avatar: defaultMascot(alice.id) } })
  async function photoStatus(client: Client) {
    return (
      await fetch(server.origin + `/api/account/photo/${photo.uploadId}`, {
        headers: { ...tailscale(z.string().parse(client.login)), Origin: server.origin },
      })
    ).status
  }
  assert.equal(await photoStatus(b), 200)
  assert.equal(await photoStatus(d), 400)
  const beforeAdd = await call(a, '/api/snapshot', Snapshot)
  const added = await call(a, '/api/group/people', GroupObservation, { ...aa, userIds: [dee.id] })
  const da = access(added.group, dee.id)
  assert.equal(added.group.members.length, 4)
  const noOp = await call(a, '/api/group/people', GroupObservation, { ...aa, userIds: [dee.id] })
  assert.equal(noOp.at, added.at, 'adding existing member emits no event')
  assert.equal((await call(d, '/api/snapshot', Snapshot)).groups[0]?.unread, 0)
  assert.ok(
    (await call(d, path(da), GroupMessage.array())).some((m) => m.id === message.id),
    'new member reads earlier history',
  )
  const joined = await replay(d, beforeAdd.cursor)
  assert.ok(joined.events.some((e) => e.kind === 'group.changed' && e.group.id === group.id))
  assert.ok(
    !joined.events.some((e) => e.kind === 'group.message.created' && e.message.id === message.id),
    'old history is fetched, not replayed across admissions',
  )
  assert.equal(await photoStatus(d), 200)
  await call(b, '/api/group/read', z.unknown(), { ...ba, cursor: '9999999999999999999' })
  const removal = await call(b, '/api/group/leave', GroupRemoval, ba)
  const afterLeave = await call(a, '/api/group/messages', GroupMessage, {
    ...aa,
    retryId: randomUUID(),
    body: `After leave ${randomUUID()}`,
  })
  assert.equal((await b.call(path(ba))).response.status, 404)
  assert.equal(await photoStatus(b), 400)
  const leftReplay = await replay(b)
  assert.ok(
    leftReplay.events.some((e) => e.kind === 'group.removed' && e.cursor === removal.cursor),
  )
  for (const secret of [message.body, afterLeave.body]) assert.ok(!leftReplay.text.includes(secret))
  assert.ok(!leftReplay.events.some((e) => e.kind === 'group.changed' && e.group.id === group.id))
  const returned = await call(c, '/api/group/people', GroupObservation, {
    ...access(group, cal.id),
    userIds: [bob.id],
  })
  const ba2 = access(returned.group, bob.id)
  assert.notEqual(ba.admission, ba2.admission)
  for (const [endpoint, payload] of [
    ['/api/group/messages', { ...ba, retryId: randomUUID(), body: 'stale' }],
    ['/api/group/read', { ...ba, cursor: afterLeave.cursor }],
    ['/api/group/people', { ...ba, userIds: [dee.id] }],
    ['/api/group/leave', ba],
  ] as const)
    assert.equal(
      (await b.call(endpoint, payload)).response.status,
      404,
      'old admission denied after re-add',
    )
  assert.equal((await b.call(path(ba))).response.status, 404)
  assert.ok((await call(b, path(ba2), GroupMessage.array())).some((m) => m.id === afterLeave.id))
  const readded = await replay(b)
  assert.ok(
    !readded.events.some(
      (e) => e.kind === 'group.message.created' && e.message.groupId === group.id,
    ),
  )
  assert.ok(
    readded.events.some(
      (e) =>
        e.kind === 'group.changed' &&
        e.group.id === group.id &&
        e.group.members.some((m) => m.userId === bob.id && m.admission === ba2.admission),
    ),
  )
  assert.equal(await photoStatus(b), 200)
  // The real server restarts with both history and membership changes persisted.
  const persisted = await call(b, '/api/snapshot', Snapshot)
  await server.stop()
  await server.start()
  assert.deepEqual(await call(b, '/api/snapshot', Snapshot), persisted)
  assert.deepEqual(await call(a, '/api/group/messages', GroupMessage, send), message)
  assert.ok((await call(b, path(ba2), GroupMessage.array())).some((m) => m.id === message.id))
  assert.ok(!(await replay(d)).text.includes(duplicateName.group.id))
  // Leave and send serialize: either the send commits first, or it is denied.
  const raceSend = { ...ba2, retryId: randomUUID(), body: 'Concurrent departure' }
  const [raced, departed] = await Promise.all([
    b.call('/api/group/messages', raceSend),
    b.call('/api/group/leave', ba2),
  ])
  assert.equal(departed.response.status, 200)
  assert.ok([200, 404].includes(raced.response.status))
  assert.equal(
    (await b.call('/api/group/messages', raceSend)).response.status,
    404,
    'authorization precedes duplicate lookup',
  )
  for (const [client, id] of [
    [d, dee.id],
    [c, cal.id],
    [a, alice.id],
  ] as const)
    await call(client, '/api/group/leave', GroupRemoval, access(returned.group, id))
  assert.equal(
    (await a.call('/api/groups', input)).response.status,
    404,
    'create retry cannot recover inaccessible group',
  )
  for (const client of [a, b, c, d])
    assert.ok(
      !(await call(client, '/api/snapshot', Snapshot)).groups.some((g) => g.id === group.id),
    )
  // Exercise the membership cap under competing additions, and paging past hidden events.
  const extras = []
  for (let i = 0; i < 31; i++) {
    const client = new Client(server.origin, `capacity-${i}@huddle.test`)
    extras.push(await joinFriend(client, invite, `Capacity ${i}`))
  }
  const first = extras[0],
    second = extras[1],
    last = extras[30]
  assert.ok(first && second && last)
  const capacity = await call(a, '/api/groups', GroupObservation, {
    retryId: randomUUID(),
    name: 'Capacity group',
    others: [first.id, second.id],
  })
  const capacityAccess = access(capacity.group, alice.id)
  await call(a, '/api/group/people', GroupObservation, {
    ...capacityAccess,
    userIds: extras.slice(2, 30).map((u) => u.id),
  })
  const [addedLast, addedDee] = await Promise.all([
    a.call('/api/group/people', { ...capacityAccess, userIds: [last.id] }),
    a.call('/api/group/people', { ...capacityAccess, userIds: [dee.id] }),
  ])
  assert.deepEqual([addedLast.response.status, addedDee.response.status].sort(), [200, 400])
  assert.equal(
    (await call(a, '/api/snapshot', Snapshot)).groups.find((g) => g.id === capacity.group.id)
      ?.members.length,
    32,
  )
  const paged = []
  for (let i = 0; i < 101; i++)
    paged.push(
      await call(a, '/api/group/messages', GroupMessage, {
        ...capacityAccess,
        retryId: randomUUID(),
        body: `Hidden page ${i}`,
      }),
    )
  const newest = await call(a, path(capacityAccess), GroupMessage.array())
  assert.equal(newest.length, 100)
  assert.equal(newest[0]?.id, paged[1]?.id)
  const oldest = await call(
    a,
    `${path(capacityAccess)}&before=${newest[0]?.cursor}`,
    GroupMessage.array(),
  )
  assert.deepEqual(oldest, [paged[0]])
  const publicRoom = await call(a, '/api/rooms', z.object({ id: z.string() }), {
    name: 'Replay after private page',
  })
  const filtered = await replay(c)
  assert.ok(
    filtered.events.some((e) => e.kind === 'room.created' && e.room.id === publicRoom.id),
    'hidden events do not consume replay page capacity',
  )
  assert.ok(!filtered.text.includes(capacity.group.id))
  process.stdout.write(
    'PASS group creation, validation, retries, four-account privacy, replay, photos, add/leave/re-add admission fencing, read markers, restart, serialized departure, the 32-person cap and history paging.\n',
  )
} catch (error) {
  process.stderr.write(server.logs())
  throw error
} finally {
  for (const socket of sockets) socket.terminate()
  await server.stop()
  await database.drop()
}
