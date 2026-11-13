import assert from 'node:assert/strict'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { RoomServiceClient } from 'livekit-server-sdk'
import pg from 'pg'
import sharp from 'sharp'
import { WebSocket } from 'ws'
import { z } from 'zod'
import {
  AccessStage,
  Blocked,
  Channel,
  DirectConversation,
  DirectMessage,
  EventPage,
  GroupAccess,
  GroupObservation,
  Members,
  Message,
  Room,
  ServerInfo,
  Snapshot,
  VoiceGrant,
  type ServerEvent,
} from '@huddle/contracts'
import {
  Client,
  inviteCode,
  joinFriend,
  migratedDatabase,
  runningLivekit,
  setupFriend,
  startServer,
  tailscale,
} from './harness'
import { LegacyEventPage, legacyAnswer } from './legacy-contracts'

const livekit = await runningLivekit()
const database = await migratedDatabase()
const code = randomUUID()
const server = await startServer({
  databaseUrl: database.url,
  port: Number(process.env.ADMIN_TEST_PORT ?? 3600),
  env: {
    SETUP_CODE: code,
    LIVEKIT_API_SECRET: livekit.secret,
    LIVEKIT_PUBLIC_URL: livekit.url,
  },
}).catch(async (error) => {
  await database.drop()
  throw error
})
const sql = new pg.Client({ connectionString: database.url })
await sql.connect()
const rooms = new RoomServiceClient(livekit.http, livekit.key, livekit.secret)
const sockets = new Set<WebSocket>()

function pass(message: string) {
  process.stdout.write(`PASS ${message}\n`)
}
async function call<S extends z.ZodType>(
  client: Client,
  path: string,
  schema: S,
  body?: unknown,
): Promise<z.output<S>> {
  const result = await client.call(path, body)
  assert.equal(result.response.status, 200, `${path}: ${JSON.stringify(result.value)}`)
  legacyAnswer(path, body !== undefined)?.parse(result.value)
  return schema.parse(result.value)
}
const gifFor = (label: string) => ({
  slug: `${label}-${randomUUID()}`,
  title: `${label} ${randomUUID()}`,
  width: 200,
  height: 150,
  animated: `https://static.klipy.com/ii/${randomUUID()}/${label}.webp`,
  still: `https://static2.klipy.com/ii/${randomUUID()}/${label}.jpg`,
})
const gifTraces = (gif: ReturnType<typeof gifFor>) => [gif.slug, gif.title, gif.animated, gif.still]
const done = z.object({}).strict()
async function status(client: Client, path: string, body?: unknown) {
  return (await client.call(path, body)).response.status
}
async function eventually(predicate: () => boolean | Promise<boolean>, message: string) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await predicate()) return
    await delay(50)
  }
  assert.ok(await predicate(), message)
}
function watch(client: Client, after: string) {
  const socket = new WebSocket(server.websocket, {
    origin: server.origin,
    headers: tailscale(z.string().parse(client.login)),
  })
  sockets.add(socket)
  const events: ServerEvent[] = []
  const frames: string[] = []
  socket.on('open', () => socket.send(JSON.stringify({ kind: 'watch', after })))
  socket.on('message', (data) => {
    frames.push(data.toString())
    LegacyEventPage.parse(JSON.parse(data.toString()))
    events.push(...EventPage.parse(JSON.parse(data.toString())).events)
  })
  socket.on('error', () => {})
  return {
    events,
    frames,
    closed: once(socket, 'close').then(([code]) => z.number().parse(code)),
    stop: () => socket.terminate(),
  }
}
async function replay(client: Client, after = '0') {
  const watcher = watch(client, after)
  await eventually(() => watcher.frames.length > 0, 'replay answers')
  await delay(150)
  watcher.stop()
  return watcher.events
}
async function head(client: Client) {
  return (await call(client, '/api/snapshot', Snapshot)).cursor
}
async function dump() {
  const tables = await sql.query<{ name: string }>(
    "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1",
  )
  const rows: { table: string; text: string }[] = []
  for (const { name } of tables.rows)
    for (const row of (await sql.query<{ text: string }>(`SELECT t::text AS text FROM "${name}" t`))
      .rows)
      rows.push({ table: name, text: row.text })
  return rows
}
async function joinCall(client: Client, channelId: string) {
  const grant = await call(client, '/api/voice/token', VoiceGrant, { channelId })
  const socket = new WebSocket(
    `${grant.url}/rtc?access_token=${grant.token}&auto_subscribe=1&sdk=js&version=2.0.0&protocol=15`,
  )
  sockets.add(socket)
  socket.on('error', () => {})
  const closed = once(socket, 'close')
  await once(socket, 'open')
  await eventually(
    async () =>
      (await rooms.listParticipants(channelId).catch(() => [])).some(
        ({ identity }) => identity === client.userId,
      ),
    'the caller reaches LiveKit',
  )
  return { closed, socket }
}
async function livekitHas(channelId: string) {
  return (await rooms.listRooms([channelId])).length > 0
}

try {
  const a = new Client(server.origin, 'admin-ada@huddle.test')
  const b = new Client(server.origin, 'admin-bo@huddle.test')
  const c = new Client(server.origin, 'admin-cy@huddle.test')
  const d = new Client(server.origin, 'admin-di@huddle.test')
  await setupFriend(a, { code, serverName: 'Admin tests', name: 'Ada' })
  const invite = await inviteCode(a)
  const bo = await joinFriend(b, invite, 'Bo')
  await joinFriend(c, invite, 'Cy')
  const di = await joinFriend(d, invite, 'Di')
  await sql.query("UPDATE member SET role = 'admin' WHERE user_id = $1", [di.id])

  const before = await head(b)
  const watcher = watch(b, before)
  assert.deepEqual(await call(a, '/api/server/rename', done, { name: "  Friends' Huddle " }), {})
  await eventually(
    () => watcher.events.some((e) => e.kind === 'server.renamed'),
    'server.renamed arrives',
  )
  assert.deepEqual(
    watcher.events.map(({ kind, ...rest }) => ({ kind, name: 'name' in rest && rest.name })),
    [{ kind: 'server.renamed', name: "Friends' Huddle" }],
  )
  assert.equal((await call(b, '/api/snapshot', Snapshot)).server.name, "Friends' Huddle")
  assert.equal((await call(b, '/api/info', ServerInfo)).name, "Friends' Huddle")
  const renamedAt = await head(b)
  await call(a, '/api/server/rename', done, { name: "Friends' Huddle" })
  assert.equal(await head(b), renamedAt, 'renaming the server to its name emits nothing')
  assert.equal(await status(b, '/api/server/rename', { name: 'Mine now' }), 403)
  for (const name of ['', '   ', 'x'.repeat(61), 'bad\u0007name'])
    assert.equal(await status(a, '/api/server/rename', { name }), 400, `server name ${name}`)
  pass('an admin renames the server, everyone hears it once, and nobody else can')

  const workshop = await call(a, '/api/rooms', Room, { name: 'Studio' })
  const lounge = await call(a, '/api/rooms', Room, { name: 'Lounge' })
  assert.equal(
    await status(a, '/api/rooms/rename', { roomId: lounge.id, name: 'STUDIO' }),
    409,
    'room names stay unique ignoring case',
  )
  const roomAt = await head(b)
  await call(a, '/api/rooms/rename', done, { roomId: workshop.id, name: 'Studio' })
  assert.equal(await head(b), roomAt, 'renaming a room to its name emits nothing')
  await call(a, '/api/rooms/rename', done, { roomId: workshop.id, name: ' Workshop ' })
  await eventually(
    () => watcher.events.some((e) => e.kind === 'room.renamed'),
    'room.renamed arrives',
  )
  assert.deepEqual(watcher.events.at(-1), {
    kind: 'room.renamed',
    cursor: watcher.events.at(-1)?.cursor,
    room: { id: workshop.id, name: 'Workshop' },
  })
  assert.equal(await status(a, '/api/rooms/rename', { roomId: randomUUID(), name: 'Nowhere' }), 404)
  assert.equal(await status(b, '/api/rooms/rename', { roomId: lounge.id, name: 'Bo' }), 403)
  assert.equal(await status(a, '/api/rooms/rename', { roomId: lounge.id, name: '' }), 400)
  pass('rooms rename live, keep case-insensitive unique names, and refuse non-admins')

  const general = await call(a, '/api/channels', Channel, {
    roomId: workshop.id,
    kind: 'text',
    name: 'general',
  })
  const game = await call(a, '/api/channels', Channel, {
    roomId: workshop.id,
    kind: 'voice',
    name: 'Game 1',
  })
  const chat = await call(a, '/api/channels', Channel, {
    roomId: lounge.id,
    kind: 'text',
    name: 'chat',
  })
  await call(a, '/api/channels/rename', done, {
    channelId: general.id,
    kind: 'text',
    name: ' Lobby ',
  })
  await call(a, '/api/channels/rename', done, {
    channelId: chat.id,
    kind: 'text',
    name: 'lobby',
  })
  await call(a, '/api/channels/rename', done, {
    channelId: game.id,
    kind: 'voice',
    name: ' Game Night ',
  })
  assert.equal(
    await status(a, '/api/channels/rename', { channelId: game.id, kind: 'voice', name: 'lobby' }),
    409,
    'text and voice channels share one namespace in a room',
  )
  assert.equal(
    await status(a, '/api/channels/rename', { channelId: general.id, kind: 'voice', name: 'x' }),
    400,
    'a rename must state the channel kind',
  )
  assert.equal(
    await status(a, '/api/channels/rename', { channelId: general.id, kind: 'text', name: 'a b' }),
    400,
  )
  assert.equal(
    await status(a, '/api/channels/rename', {
      channelId: randomUUID(),
      kind: 'text',
      name: 'gone',
    }),
    404,
  )
  assert.equal(
    await status(b, '/api/channels/rename', { channelId: chat.id, kind: 'text', name: 'mine' }),
    403,
  )
  const channelAt = await head(b)
  await call(a, '/api/channels/rename', done, { channelId: chat.id, kind: 'text', name: 'lobby' })
  assert.equal(await head(b), channelAt, 'renaming a channel to its name emits nothing')
  await eventually(
    () => watcher.events.filter((e) => e.kind === 'channel.renamed').length === 3,
    'three channel.renamed events arrive',
  )
  assert.deepEqual(
    watcher.events.flatMap((e) => (e.kind === 'channel.renamed' ? [e.channel] : [])),
    [
      { ...general, name: 'lobby' },
      { ...chat, name: 'lobby' },
      { ...game, name: 'Game Night' },
    ],
    'text names are normalized, voice names keep their case, and the same name works in another room',
  )
  pass('channels rename live, normalized by kind, unique within their room')

  const adaWatch = watch(a, await head(a))
  const diWatch = watch(d, await head(d))
  for (let round = 0; round < 5; round++) {
    const names = [`Lounge ${round}a`, `Lounge ${round}d`]
    const results = await Promise.all([
      a.call('/api/rooms/rename', { roomId: lounge.id, name: names[0] }),
      d.call('/api/rooms/rename', { roomId: lounge.id, name: names[1] }),
    ])
    assert.deepEqual(
      results.map((r) => r.response.status),
      [200, 200],
    )
  }
  const settled = (await call(c, '/api/snapshot', Snapshot)).rooms.find((r) => r.id === lounge.id)
  for (const seen of [adaWatch, diWatch]) {
    await eventually(
      () => seen.events.filter((e) => e.kind === 'room.renamed').length === 10,
      'every concurrent rename arrives',
    )
    const renames = seen.events.flatMap((e) => (e.kind === 'room.renamed' ? [e] : []))
    assert.deepEqual(
      renames.map((e) => e.cursor),
      renames.map((e) => e.cursor).toSorted((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1)),
    )
    assert.deepEqual(renames.at(-1)?.room, settled, 'both admins end on the latest rename')
  }
  adaWatch.stop()
  diWatch.stop()
  pass('two admins renaming at once serialize, and both end on the higher cursor')

  const doomed = await call(a, '/api/channels', Channel, {
    roomId: workshop.id,
    kind: 'text',
    name: 'doomed',
  })
  const secret = `secret-${randomUUID()}`
  const edited = `edited-${randomUUID()}`
  const kept = `kept-${randomUUID()}`
  const first = await call(b, '/api/messages', Message, {
    channelId: doomed.id,
    retryId: randomUUID(),
    body: `@Ada ${secret}`,
  })
  const second = await call(a, '/api/messages', Message, {
    channelId: doomed.id,
    retryId: randomUUID(),
    body: `Second ${secret}`,
  })
  const editInput = {
    channelId: doomed.id,
    messageId: first.id,
    expectedRevision: '0',
    retryId: randomUUID(),
    body: `@Ada ${edited}`,
  }
  await call(b, '/api/messages/edit', Message, editInput)
  await call(c, '/api/read', done, { channelId: doomed.id, cursor: first.cursor })
  await call(a, '/api/messages', Message, {
    channelId: general.id,
    retryId: randomUUID(),
    body: kept,
  })
  const unread = async (client: Client) =>
    (await call(client, '/api/snapshot', Snapshot)).unread.find((u) => u.channelId === doomed.id)
  assert.deepEqual(await unread(a), { channelId: doomed.id, count: 1, mentions: 1 })
  assert.deepEqual(await unread(c), { channelId: doomed.id, count: 1, mentions: 0 })
  const doomedGif = gifFor('doomed')
  await call(b, '/api/messages', Message, {
    channelId: doomed.id,
    retryId: randomUUID(),
    gif: doomedGif,
  })
  const cyWatch = watch(c, await head(c))
  for (const confirm of ['Doomed', 'doom', 'lobby'])
    assert.equal(
      await status(a, '/api/channels/delete', { channelId: doomed.id, confirm }),
      409,
      `confirming with ${confirm}`,
    )
  assert.equal(
    await status(b, '/api/channels/delete', { channelId: doomed.id, confirm: 'doomed' }),
    403,
  )
  assert.equal(await status(a, '/api/channels/delete', { channelId: doomed.id }), 400)
  await call(a, '/api/channels/delete', done, { channelId: doomed.id, confirm: ' doomed ' })
  await eventually(
    () => cyWatch.events.some((e) => e.kind === 'channel.deleted'),
    'channel.deleted arrives',
  )
  assert.deepEqual(cyWatch.events.at(-1), {
    kind: 'channel.deleted',
    cursor: cyWatch.events.at(-1)?.cursor,
    channelId: doomed.id,
    roomId: workshop.id,
  })
  cyWatch.stop()
  const rows = await dump()
  for (const body of [secret, edited, ...gifTraces(doomedGif)])
    assert.deepEqual(
      rows.filter((row) => row.text.includes(body)),
      [],
      'no table keeps a deleted message body or GIF',
    )
  assert.ok(
    rows.some((row) => row.text.includes(kept)),
    'other channels keep their messages',
  )
  const mentioning = rows.filter((row) => row.text.includes(doomed.id))
  assert.deepEqual(
    mentioning.map((row) => row.table),
    ['event'],
    'only the tombstone names a deleted channel',
  )
  assert.match(mentioning[0]?.text ?? '', /channel\.deleted/)
  assert.equal(await unread(a), undefined, 'mentions in a deleted channel are gone')
  assert.equal(await unread(c), undefined, 'unread counts in a deleted channel are gone')
  assert.equal(
    (await call(c, '/api/snapshot', Snapshot)).channels.some((ch) => ch.id === doomed.id),
    false,
  )
  assert.equal(await status(c, `/api/messages?channelId=${doomed.id}`), 404)
  assert.equal(
    await status(b, '/api/messages', {
      channelId: doomed.id,
      retryId: randomUUID(),
      body: 'too late',
    }),
    404,
  )
  assert.equal(
    await status(b, '/api/messages/edit', {
      ...editInput,
      retryId: randomUUID(),
      expectedRevision: first.revision,
    }),
    404,
  )
  assert.equal(await status(c, '/api/read', { channelId: doomed.id, cursor: second.cursor }), 404)
  assert.equal(await status(c, '/api/voice/token', { channelId: doomed.id }), 404)
  assert.equal(
    await status(a, '/api/channels/delete', { channelId: doomed.id, confirm: 'doomed' }),
    404,
    'a repeated delete finds nothing',
  )
  for (const after of ['0', first.cursor]) {
    const events = await replay(c, after)
    assert.equal(events.at(-1)?.kind, 'channel.deleted', `replay from ${after} ends with it`)
    assert.deepEqual(
      events.filter(
        (e) =>
          ('message' in e && 'channelId' in e.message && e.message.channelId === doomed.id) ||
          ('channel' in e && e.channel.id === doomed.id),
      ),
      [],
      `replay from ${after} carries nothing from the deleted channel`,
    )
  }
  pass(
    'deleting a channel needs its exact name and purges messages, edits, receipts, reads, mentions and events',
  )

  const racing = await call(a, '/api/channels', Channel, {
    roomId: workshop.id,
    kind: 'text',
    name: 'racing',
  })
  const lock = new pg.Client({ connectionString: database.url })
  await lock.connect()
  await lock.query('BEGIN')
  await lock.query('SELECT singleton FROM server FOR UPDATE')
  const send = (index: number) =>
    (index % 2 ? b : c).call('/api/messages', {
      channelId: racing.id,
      retryId: randomUUID(),
      body: `race ${index}`,
    })
  const sends = [send(0), send(1)]
  await delay(200)
  const deletion = a.call('/api/channels/delete', { channelId: racing.id, confirm: 'racing' })
  await delay(200)
  sends.push(...Array.from({ length: 18 }, (_, index) => send(index + 2)))
  await delay(200)
  await lock.query('COMMIT')
  await lock.end()
  const statuses = (await Promise.all(sends)).map((r) => r.response.status)
  assert.equal((await deletion).response.status, 200)
  assert.deepEqual(
    statuses.filter((s) => s !== 200 && s !== 404),
    [],
    'a send racing a delete answers 200 or 404, never 500',
  )
  assert.ok(statuses.includes(200) && statuses.includes(404), `statuses ${statuses}`)
  assert.equal(
    (await sql.query('SELECT 1 FROM message WHERE channel_id = $1', [racing.id])).rowCount,
    0,
    'no message survives a racing delete',
  )
  const renamedAway = await call(a, '/api/channels', Channel, {
    roomId: workshop.id,
    kind: 'text',
    name: 'renamed-away',
  })
  const [rename, removal] = await Promise.all([
    d.call('/api/channels/rename', { channelId: renamedAway.id, kind: 'text', name: 'moved' }),
    a.call('/api/channels/delete', { channelId: renamedAway.id, confirm: 'renamed-away' }),
  ])
  assert.ok(
    [
      [200, 409],
      [404, 200],
    ].some(
      ([renamed, deleted]) =>
        rename.response.status === renamed && removal.response.status === deleted,
    ),
    `a rename racing a delete either lands first and the delete refuses the old name, or answers 404 (${rename.response.status}, ${removal.response.status})`,
  )
  pass(
    `sends and renames racing a delete answer 200 or 404 (${statuses.filter((s) => s === 200).length} sent, ${statuses.filter((s) => s === 404).length} refused) and leave nothing`,
  )

  const attic = await call(a, '/api/rooms', Room, { name: 'Attic' })
  const atticText = await call(a, '/api/channels', Channel, {
    roomId: attic.id,
    kind: 'text',
    name: 'boxes',
  })
  const atticVoice = await call(a, '/api/channels', Channel, {
    roomId: attic.id,
    kind: 'voice',
    name: 'Attic call',
  })
  const atticBody = `attic-${randomUUID()}`
  await call(b, '/api/messages', Message, {
    channelId: atticText.id,
    retryId: randomUUID(),
    body: atticBody,
  })
  const atticGif = gifFor('attic')
  await call(b, '/api/messages', Message, {
    channelId: atticText.id,
    retryId: randomUUID(),
    gif: atticGif,
  })
  const atticSpare = await call(a, '/api/channels', Channel, {
    roomId: attic.id,
    kind: 'text',
    name: 'spare',
  })
  await call(a, '/api/channels/delete', done, { channelId: atticSpare.id, confirm: 'spare' })
  const inCall = await joinCall(c, atticVoice.id)
  const roomWatch = watch(b, await head(b))
  assert.equal(await status(a, '/api/rooms/delete', { roomId: attic.id, confirm: 'attic' }), 409)
  assert.equal(await status(b, '/api/rooms/delete', { roomId: attic.id, confirm: 'Attic' }), 403)
  await call(a, '/api/rooms/delete', done, { roomId: attic.id, confirm: 'Attic' })
  await eventually(
    () => roomWatch.events.some((e) => e.kind === 'room.deleted'),
    'room.deleted arrives',
  )
  assert.deepEqual(roomWatch.events.at(-1), {
    kind: 'room.deleted',
    cursor: roomWatch.events.at(-1)?.cursor,
    roomId: attic.id,
  })
  roomWatch.stop()
  const afterRoom = await call(b, '/api/snapshot', Snapshot)
  assert.equal(
    afterRoom.rooms.some((r) => r.id === attic.id),
    false,
  )
  assert.equal(
    afterRoom.channels.some((ch) => ch.roomId === attic.id),
    false,
  )
  const atticRows = await dump()
  for (const trace of [atticBody, ...gifTraces(atticGif)])
    assert.deepEqual(
      atticRows.filter((row) => row.text.includes(trace)),
      [],
      'no table keeps a message or GIF from a deleted room',
    )
  assert.deepEqual(
    atticRows.filter((row) => row.text.includes(attic.id)).map((row) => row.table),
    ['event'],
    'only room.deleted names a deleted room, including earlier channel tombstones in it',
  )
  assert.equal(
    (await replay(b)).some((e) => e.kind === 'channel.deleted' && e.channelId === atticSpare.id),
    false,
  )
  await eventually(async () => !(await livekitHas(atticVoice.id)), 'the room call closes')
  await inCall.closed
  await call(a, '/api/rooms', Room, { name: 'Attic' })
  pass('deleting a room cascades its channels, tombstones and calls, and frees its name')

  const caller = await joinCall(b, game.id)
  assert.equal(await livekitHas(game.id), true)
  await call(a, '/api/channels/delete', done, { channelId: game.id, confirm: 'Game Night' })
  await eventually(async () => !(await livekitHas(game.id)), 'LiveKit loses the deleted room')
  await caller.closed
  assert.equal(await status(b, '/api/voice/token', { channelId: game.id }), 404)
  assert.deepEqual(
    (await sql.query('SELECT id FROM deleted_voice_channel ORDER BY id')).rows
      .map((row) => row.id)
      .sort(),
    [atticVoice.id, game.id].sort(),
  )
  pass('deleting a voice channel closes its LiveKit room within seconds and refuses new tokens')
  watcher.stop()

  const s = new Client(server.origin, 'admin-sam@huddle.test')
  const sam = await joinFriend(s, invite, 'Sam')
  const fillers = []
  for (let index = 0; index < 31; index++)
    fillers.push(
      await joinFriend(
        new Client(server.origin, `admin-filler-${index}@huddle.test`),
        invite,
        `Filler ${index}`,
      ),
    )
  const image = await sharp({
    create: { width: 16, height: 16, channels: 3, background: '#2f855a' },
  })
    .png()
    .toBuffer()
  const form = new FormData()
  form.set('photo', new File([new Uint8Array(image)], 'sam.png', { type: 'image/png' }))
  const uploaded = await fetch(`${server.origin}/api/account/photo`, {
    method: 'POST',
    headers: {
      Origin: server.origin,
      ...tailscale('admin-sam@huddle.test'),
      'X-Huddle-User': sam.id,
    },
    body: form,
  })
  assert.equal(uploaded.status, 200)
  const photo = {
    kind: 'photo' as const,
    uploadId: z.object({ uploadId: z.uuid() }).parse(await uploaded.json()).uploadId,
  }
  await s.act({ kind: 'profile.save', profile: { name: 'Sam', avatar: photo } })
  const samMessage = await call(s, '/api/messages', Message, {
    channelId: general.id,
    retryId: randomUUID(),
    body: 'Sam was here',
  })
  const conversation = await call(s, '/api/direct/conversations', DirectConversation, {
    userId: bo.id,
  })
  await call(s, '/api/direct/messages', DirectMessage, {
    conversationId: conversation.id,
    retryId: randomUUID(),
    body: 'Hi Bo, from Sam',
  })
  const boSent = {
    conversationId: conversation.id,
    retryId: randomUUID(),
    body: 'Hi Sam, from Bo',
  }
  const boReply = await call(b, '/api/direct/messages', DirectMessage, boSent)
  const boGifSent = { conversationId: conversation.id, retryId: randomUUID(), gif: gifFor('bo') }
  const boGif = await call(b, '/api/direct/messages', DirectMessage, boGifSent)
  const group = (
    await call(b, '/api/groups', GroupObservation, {
      retryId: randomUUID(),
      name: 'Everyone',
      others: [sam.id, ...fillers.slice(0, 30).map(({ id }) => id)],
    })
  ).group
  const boAccess = GroupAccess.parse({
    groupId: group.id,
    admission: group.members.find(({ userId }) => userId === bo.id)?.admission,
  })
  const late = fillers[30]
  assert.ok(late)
  assert.equal(
    await status(b, '/api/group/people', { ...boAccess, userIds: [late.id] }),
    400,
    'a full group refuses a 33rd person',
  )
  const hangout = await call(a, '/api/channels', Channel, {
    roomId: workshop.id,
    kind: 'voice',
    name: 'Hangout',
  })
  const samCall = await joinCall(s, hangout.id)
  await joinCall(c, hangout.id)
  const samWatch = watch(s, await head(s))
  const boWatch = watch(b, await head(b))
  await eventually(() => samWatch.frames.length > 0 && boWatch.frames.length > 0, 'both watch')
  const countBefore = (await call(b, '/api/snapshot', Snapshot)).server.memberCount

  assert.equal(await status(b, '/api/members/remove', { userId: sam.id }), 403)
  assert.equal(await status(a, '/api/members/remove', { userId: a.userId }), 400)
  assert.equal(await status(a, '/api/members/remove', { userId: di.id }), 403)
  assert.equal(await status(a, '/api/members/remove', { userId: randomUUID() }), 404)
  assert.equal(await status(a, '/api/members/remove', { userId: '' }), 400)
  assert.equal(await status(a, '/api/members/remove', { userId: sam.id, extra: 1 }), 400)
  const removedAt = await head(a)
  assert.deepEqual(await call(a, '/api/members/remove', done, { userId: sam.id }), {})
  assert.equal(
    await Promise.race([samWatch.closed, delay(2000).then(() => 'still open')]),
    1008,
    "the removed person's socket closes at once",
  )
  assert.deepEqual(await s.stage(), { kind: 'removed', login: 'admin-sam@huddle.test' })
  for (const path of ['/api/snapshot', '/api/members', '/api/account', '/api/blocked'])
    assert.equal(await status(s, path), 401, `a removed person reads nothing at ${path}`)
  s.userId = sam.id
  assert.equal(
    await status(s, '/api/messages', {
      channelId: general.id,
      retryId: randomUUID(),
      body: 'Still here?',
    }),
    401,
  )
  s.userId = null
  assert.deepEqual(
    await s.act({ kind: 'account.join', code: invite, name: 'Sam again' }),
    { kind: 'removed', login: 'admin-sam@huddle.test' },
    'the invite does not let a removed person back',
  )
  assert.equal((await sql.query('SELECT 1 FROM member WHERE user_id = $1', [sam.id])).rowCount, 0)
  await eventually(
    () => boWatch.events.some((e) => e.kind === 'member.removed'),
    'member.removed arrives',
  )
  assert.deepEqual(
    boWatch.events.find((e) => e.kind === 'member.removed'),
    {
      kind: 'member.removed',
      cursor: boWatch.events.find((e) => e.kind === 'member.removed')?.cursor,
      userId: sam.id,
    },
  )
  const roster = await call(b, '/api/members', Members)
  assert.equal(
    roster.members.some(({ id }) => id === sam.id),
    false,
    'the roster drops them',
  )
  assert.equal((await call(b, '/api/snapshot', Snapshot)).server.memberCount, countBefore - 1)
  const lobby = await call(b, `/api/messages?channelId=${general.id}`, Message.array())
  assert.deepEqual(
    lobby.find(({ id }) => id === samMessage.id),
    { ...samMessage, authorName: 'Sam', authorAvatar: photo },
    'their messages stay under their name and photo',
  )
  assert.equal(
    (
      await fetch(`${server.origin}/api/account/photo/${photo.uploadId}`, {
        headers: { Origin: server.origin, ...tailscale('admin-bo@huddle.test') },
      })
    ).status,
    200,
    "a removed person's photo still loads beside their messages",
  )
  await eventually(
    () =>
      boWatch.events.some(
        (e) =>
          e.kind === 'group.changed' &&
          e.group.id === group.id &&
          e.group.members.length === 31 &&
          !e.group.members.some(({ userId }) => userId === sam.id),
      ),
    'the group republishes without them',
  )
  await call(b, '/api/group/people', GroupObservation, { ...boAccess, userIds: [late.id] })
  const directs = await call(
    b,
    `/api/direct/messages?conversationId=${conversation.id}`,
    DirectMessage.array(),
  )
  assert.deepEqual(
    directs.map(({ body }) => body),
    ['Hi Bo, from Sam', 'Hi Sam, from Bo', boGif.body],
    'the peer keeps the conversation',
  )
  const refused = await b.call('/api/direct/messages', {
    conversationId: conversation.id,
    retryId: randomUUID(),
    body: 'Are you there?',
  })
  assert.equal(refused.response.status, 409)
  assert.deepEqual(refused.value, { message: 'This person is no longer on this server.' })
  assert.deepEqual(
    await call(b, '/api/direct/messages', DirectMessage, boSent),
    boReply,
    'a retry of a message sent before the removal returns it',
  )
  assert.deepEqual(
    await call(b, '/api/direct/messages', DirectMessage, boGifSent),
    boGif,
    'a retry of a GIF sent before the removal returns it',
  )
  assert.equal(
    await status(b, '/api/direct/messages', { ...boGifSent, retryId: randomUUID() }),
    409,
    'a new GIF to a removed person is refused',
  )
  await call(b, '/api/direct/messages/edit', DirectMessage, {
    conversationId: conversation.id,
    messageId: boReply.id,
    expectedRevision: '0',
    retryId: randomUUID(),
    body: 'Hi Sam, from Bo, edited',
  })
  await call(b, '/api/direct/read', done, {
    conversationId: conversation.id,
    cursor: boReply.cursor,
  })
  assert.equal(await status(b, '/api/direct/conversations', { userId: sam.id }), 404)
  assert.deepEqual(
    (await call(b, '/api/members', Members)).former,
    [{ id: sam.id, name: 'Sam', avatar: photo }],
    'a direct peer who left stays named in former',
  )
  assert.deepEqual((await call(c, '/api/members', Members)).former, [])
  const mention = await call(a, '/api/messages', Message, {
    channelId: general.id,
    retryId: randomUUID(),
    body: '@Sam are you there?',
  })
  assert.equal(
    (await sql.query('SELECT 1 FROM message_mention WHERE message_id = $1', [mention.id])).rowCount,
    0,
    'a removed person cannot be mentioned',
  )
  assert.notEqual(
    await Promise.race([samCall.closed, delay(3000).then(() => 'still in the call')]),
    'still in the call',
    'a removed caller leaves the call within three seconds',
  )
  assert.deepEqual(
    (await rooms.listParticipants(hangout.id)).map(({ identity }) => identity),
    [c.userId],
    'a removed caller leaves at once while a member without a socket keeps the grace period',
  )
  const inHangout = () =>
    EventPage.parse(JSON.parse(boWatch.frames.at(-1) ?? ''))
      .voice?.find(({ channelId }) => channelId === hangout.id)
      ?.people.map(({ id }) => id)
  await eventually(
    () => JSON.stringify(inHangout()) === JSON.stringify([c.userId]),
    'presence lists the member still in the call and not the removed one',
  )
  const settledAt = await head(a)
  assert.deepEqual(await call(a, '/api/members/remove', done, { userId: sam.id }), {})
  assert.equal(await head(a), settledAt, 'removing someone already removed emits nothing')
  assert.ok(BigInt(settledAt) > BigInt(removedAt))
  const list = await call(a, '/api/blocked', Blocked)
  assert.deepEqual(
    list.blocked.map(({ id, name, avatar }) => ({ id, name, avatar })),
    [{ id: sam.id, name: 'Sam', avatar: photo }],
  )
  assert.ok(Date.parse(list.blocked[0]?.removedAt ?? '') > Date.now() - 60000)
  assert.equal(await status(b, '/api/blocked'), 403)
  boWatch.stop()
  pass(
    'removing a member closes their socket and call, blocks the invite, keeps their messages and photo, frees their group seat, and leaves direct history readable',
  )

  const r = new Client(server.origin, 'admin-rae@huddle.test')
  const rae = await joinFriend(r, invite, 'Rae')
  await call(a, '/api/members/remove', done, { userId: rae.id })
  await call(a, '/api/members/unblock', done, { userId: rae.id })
  assert.equal((await r.stage()).kind, 'join')
  const held = new pg.Client({ connectionString: database.url })
  await held.connect()
  await held.query('BEGIN')
  await held.query('SELECT singleton FROM server FOR UPDATE')
  const rejoin = () =>
    new Client(server.origin, 'admin-rae@huddle.test').call('/api/access', {
      kind: 'account.join',
      code: invite,
      name: 'Rae',
    })
  const joins = [rejoin()]
  await delay(200)
  const raeRemoval = a.call('/api/members/remove', { userId: rae.id })
  await delay(200)
  joins.push(rejoin(), rejoin(), rejoin(), rejoin())
  await delay(300)
  await held.query('COMMIT')
  await held.end()
  assert.equal((await raeRemoval).response.status, 200)
  const stages = (await Promise.all(joins)).map(({ response, value }) => {
    assert.equal(response.status, 200)
    return AccessStage.parse(value).kind
  })
  assert.deepEqual(stages.slice(1), ['removed', 'removed', 'removed', 'removed'])
  assert.equal(
    (await sql.query('SELECT 1 FROM member WHERE user_id = $1', [rae.id])).rowCount,
    0,
    'a join racing a removal never leaves a member row',
  )
  assert.equal((await r.stage()).kind, 'removed')
  pass('joins queued around a removal serialize with it, and none slips back in')

  assert.equal(await status(b, '/api/members/unblock', { userId: sam.id }), 403)
  assert.deepEqual(await call(a, '/api/members/unblock', done, { userId: sam.id }), {})
  await call(a, '/api/members/unblock', done, { userId: sam.id })
  assert.deepEqual(
    (await call(a, '/api/blocked', Blocked)).blocked.map(({ id }) => id),
    [rae.id],
  )
  assert.equal(
    (
      await fetch(`${server.origin}/api/account/photo/${photo.uploadId}`, {
        headers: { Origin: server.origin, ...tailscale('admin-bo@huddle.test') },
      })
    ).status,
    200,
    "an unblocked person's photo still loads before they rejoin",
  )
  assert.deepEqual(await s.stage(), {
    kind: 'join',
    login: 'admin-sam@huddle.test',
    suggestedName: 'admin-sam',
  })
  const back = await joinFriend(s, invite, 'Sam again')
  assert.equal(back.id, sam.id, 'rejoining restores the same account')
  const restored = await call(s, '/api/snapshot', Snapshot)
  assert.deepEqual(
    restored.directs.map(({ id }) => id),
    [conversation.id],
  )
  assert.deepEqual(restored.groups, [], 'groups do not come back')
  assert.deepEqual((await call(b, '/api/members', Members)).former, [])
  await call(b, '/api/direct/messages', DirectMessage, {
    conversationId: conversation.id,
    retryId: randomUUID(),
    body: 'Welcome back',
  })
  pass(
    'unblocking lets the person rejoin as the same account with their direct messages but not their groups',
  )
} catch (error) {
  process.stderr.write(server.logs())
  throw error
} finally {
  for (const socket of sockets) socket.terminate()
  await sql.end()
  await server.stop()
  await database.drop()
}
