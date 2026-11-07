import { randomUUID } from 'node:crypto'
import { AccessToken, TrackSource } from 'livekit-server-sdk'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import {
  GroupConversation,
  GroupMetadata,
  GroupMessage,
  GroupAccess,
  GroupId,
  Admission,
  type CreateGroup,
  type AddGroupPeople,
  type SendGroupMessage,
  type MarkGroupRead,
  Avatar,
  Channel,
  DirectConversation,
  DirectMessage,
  Members,
  Message,
  Room,
  Unread,
  Server,
  ServerEvent,
  UserId,
  VoiceGrant,
  type ChannelId,
  type ConversationId,
  type SendMessage,
  type SendDirectMessage,
  type CreateChannel,
  type CreateRoom,
  type JoinVoice,
  type MarkRead,
  type MarkDirectRead,
  type OpenDirect,
} from '@huddle/contracts'
import { config } from './config'
import { db } from './db'

export class DomainError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}
const channelColumns = 'id, room_id AS "roomId", name, kind'
const authoredColumns =
  'm.id, m.author_id AS "authorId", m.author_name AS "authorName", m.author_avatar AS "authorAvatar", m.retry_id AS "retryId", m.body, m.cursor::text, to_char(m.created_at AT TIME ZONE \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"\') AS "createdAt"'
const messageColumns = `m.channel_id AS "channelId", ${authoredColumns}`
const directColumns = `m.conversation_id AS "conversationId", ${authoredColumns}`
const conversationRows = `SELECT c.id, CASE WHEN c.user_a = $1 THEN c.user_b ELSE c.user_a END AS "peerId",
    to_jsonb(latest) AS latest,
    (SELECT count(*)::integer FROM direct_message u
      WHERE u.conversation_id = c.id AND u.author_id <> $1 AND u.cursor > coalesce(
        (SELECT r.cursor FROM direct_read r WHERE r.user_id = $1 AND r.conversation_id = c.id), 0)
    ) AS unread
  FROM direct_conversation c
  LEFT JOIN LATERAL (
    SELECT ${directColumns} FROM direct_message m WHERE m.conversation_id = c.id ORDER BY m.cursor DESC LIMIT 1
  ) latest ON true
  WHERE $1 IN (c.user_a, c.user_b)`

export async function transaction<T>(
  operation: (sql: PoolClient) => Promise<T>,
  snapshot = false,
): Promise<T> {
  const sql = await db.connect()
  try {
    await sql.query(snapshot ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN')
    const result = await operation(sql)
    await sql.query('COMMIT')
    return result
  } catch (error) {
    await sql.query('ROLLBACK')
    if (error instanceof Error && 'code' in error && error.code === '23505')
      throw new DomainError(409, 'That name is already in use.')
    throw error
  } finally {
    sql.release()
  }
}

export async function requireMember(
  sql: Pick<PoolClient, 'query'>,
  userId: UserId,
  need: 'member' | 'admin' = 'member',
) {
  const result = await sql.query<Record<string, unknown>>(
    'SELECT s.name, m.role, (SELECT count(*)::integer FROM member) AS "memberCount", (SELECT count(*)::integer FROM channel) AS "channelCount" FROM member m CROSS JOIN server s WHERE m.user_id = $1',
    [userId],
  )
  if (!result.rowCount)
    throw new DomainError(403, 'You are not a member of this server. Ask an admin for an invite.')
  const server = Server.parse(result.rows[0])
  if (need === 'admin' && server.role !== 'admin')
    throw new DomainError(403, 'Only an admin can do that.')
  return server
}
async function lockServer(sql: PoolClient) {
  await sql.query('SELECT singleton FROM server FOR UPDATE')
}
async function appendEvent<T extends z.infer<typeof ServerEvent>>(
  sql: PoolClient,
  makeEvent: (cursor: string) => T,
  audience: UserId[] | 'everyone',
  groupId: GroupId | null = null,
) {
  const result = await sql.query<Record<string, unknown>>(
    'UPDATE server SET cursor = cursor + 1 RETURNING cursor::text',
  )
  const { cursor } = z.object({ cursor: z.string() }).parse(result.rows[0])
  const event = makeEvent(cursor)
  await sql.query('INSERT INTO event(cursor, event, audience, group_id) VALUES ($1, $2, $3, $4)', [
    cursor,
    event,
    audience === 'everyone' ? null : audience,
    groupId,
  ])
  await sql.query("SELECT pg_notify('huddle_commit', '')")
  return event
}
export async function snapshot(userId: UserId) {
  return transaction(async (sql) => {
    const server = await requireMember(sql, userId)
    const rooms = await sql.query<Record<string, unknown>>(
      'SELECT id, name FROM room ORDER BY lower(name), id',
    )
    const channels = await sql.query<Record<string, unknown>>(
      `SELECT ${channelColumns} FROM channel ORDER BY name, id`,
    )
    const unread = await sql.query<Record<string, unknown>>(
      `SELECT m.channel_id AS "channelId", count(*)::integer AS count,
        (count(*) FILTER (WHERE EXISTS (SELECT 1 FROM message_mention mm WHERE mm.message_id = m.id AND mm.user_id = $1)))::integer AS mentions
      FROM message m LEFT JOIN channel_read r ON r.channel_id = m.channel_id AND r.user_id = $1
      WHERE m.cursor > coalesce(r.cursor, 0) AND m.author_id <> $1
      GROUP BY m.channel_id ORDER BY m.channel_id`,
      [userId],
    )
    const directs = await sql.query<Record<string, unknown>>(
      `${conversationRows} AND latest.id IS NOT NULL ORDER BY latest.cursor::bigint DESC`,
      [userId],
    )
    const cursorRows = await sql.query<Record<string, unknown>>('SELECT cursor::text FROM server')
    const { cursor } = z.object({ cursor: z.string() }).parse(cursorRows.rows[0])
    return {
      server,
      rooms: Room.array().parse(rooms.rows),
      channels: Channel.array().parse(channels.rows),
      unread: Unread.array().parse(unread.rows),
      directs: DirectConversation.array().parse(directs.rows),
      groups: await groupSummaries(sql, userId),
      cursor,
    }
  }, true)
}
export async function createRoom(userId: UserId, input: z.infer<typeof CreateRoom>) {
  return transaction(async (sql) => {
    await lockServer(sql)
    await requireMember(sql, userId, 'admin')
    const room = Room.parse({ id: randomUUID(), ...input })
    await sql.query('INSERT INTO room(id, name) VALUES ($1, $2)', [room.id, room.name])
    await appendEvent(sql, (cursor) => ({ kind: 'room.created', room, cursor }), 'everyone')
    return room
  })
}
export async function createChannel(userId: UserId, input: z.infer<typeof CreateChannel>) {
  return transaction(async (sql) => {
    const room = await sql.query('SELECT 1 FROM room WHERE id = $1', [input.roomId])
    if (!room.rowCount) throw new DomainError(404, 'Room not found.')
    const channel = Channel.parse({ id: randomUUID(), ...input })
    await lockServer(sql)
    await requireMember(sql, userId, 'admin')
    await sql.query('INSERT INTO channel(id, room_id, name, kind) VALUES ($1, $2, $3, $4)', [
      channel.id,
      channel.roomId,
      channel.name,
      channel.kind,
    ])
    await appendEvent(
      sql,
      (cursor) => ({
        kind: 'channel.created',
        channel,
        cursor,
      }),
      'everyone',
    )
    return channel
  })
}
export async function history(userId: UserId, channelId: ChannelId, before?: string) {
  return transaction(async (sql) => {
    await findChannel(sql, channelId)
    await requireMember(sql, userId)
    const messages = await sql.query<Record<string, unknown>>(
      `SELECT ${messageColumns} FROM message m WHERE m.channel_id = $1 AND ($2::bigint IS NULL OR m.cursor < $2::bigint) ORDER BY m.cursor DESC LIMIT 100`,
      [channelId, before ?? null],
    )
    return Message.array().parse(messages.rows).reverse()
  }, true)
}
export async function sendMessage(
  user: { id: UserId; name: string; avatar: z.infer<typeof Avatar> },
  input: z.infer<typeof SendMessage>,
) {
  return transaction(async (sql) => {
    await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [user.id])
    const channel = await findChannel(sql, input.channelId)
    await lockServer(sql)
    await requireMember(sql, user.id)
    if (channel.kind === 'voice') throw new DomainError(409, 'Voice channels do not hold messages.')
    const duplicate = await sql.query<Record<string, unknown>>(
      `SELECT ${messageColumns} FROM message m WHERE m.author_id = $1 AND m.retry_id = $2`,
      [user.id, input.retryId],
    )
    if (duplicate.rowCount) {
      const message = Message.parse(duplicate.rows[0])
      if (message.body !== input.body || message.channelId !== input.channelId)
        throw new DomainError(409, 'This retry ID was already used for a different message.')
      return message
    }
    const members = await sql.query<Record<string, unknown>>(
      'SELECT u.id, u.name FROM member m JOIN "user" u ON u.id = m.user_id',
    )
    const mentioned = mentionedUsers(
      input.body,
      z.object({ id: UserId, name: z.string() }).array().parse(members.rows),
      user.id,
    )
    const { message } = await appendEvent(
      sql,
      (cursor) => ({
        kind: 'message.created',
        cursor,
        mentions: mentioned,
        message: {
          id: randomUUID(),
          ...input,
          authorId: user.id,
          authorName: user.name,
          authorAvatar: user.avatar,
          cursor,
          createdAt: new Date().toISOString(),
        },
      }),
      'everyone',
    )
    await sql.query(
      'INSERT INTO message(id, channel_id, author_id, author_name, retry_id, body, cursor, created_at, author_avatar) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        message.id,
        message.channelId,
        message.authorId,
        message.authorName,
        message.retryId,
        message.body,
        message.cursor,
        message.createdAt,
        JSON.stringify(message.authorAvatar),
      ],
    )
    if (mentioned.length)
      await sql.query(
        'INSERT INTO message_mention(message_id, user_id) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING',
        [message.id, mentioned],
      )
    return message
  })
}
export function mentionedUsers(
  body: string,
  members: { id: UserId; name: string }[],
  authorId: UserId,
): UserId[] {
  const mentions = (name: string) =>
    name !== '' &&
    new RegExp(
      `(?:^|[^\\p{L}\\p{N}_])@${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?![\\p{L}\\p{N}_])`,
      'iu',
    ).test(body)
  return members
    .filter((member) => member.id !== authorId)
    .filter((member) => {
      const name = member.name.trim()
      return mentions(name) || mentions(name.split(/\s+/)[0] ?? '')
    })
    .map((member) => member.id)
}
export async function markRead(userId: UserId, input: z.infer<typeof MarkRead>) {
  await transaction(async (sql) => {
    await findChannel(sql, input.channelId)
    await requireMember(sql, userId)
    await sql.query(
      'INSERT INTO channel_read(user_id, channel_id, cursor) SELECT $1, $2::uuid, LEAST($3::numeric, s.cursor) FROM server s ON CONFLICT (user_id, channel_id) DO UPDATE SET cursor = GREATEST(channel_read.cursor, excluded.cursor)',
      [userId, input.channelId, input.cursor],
    )
  })
}
export async function requireConversation(
  sql: Pick<PoolClient, 'query'>,
  conversationId: ConversationId,
  userId: UserId,
) {
  const rows = await sql.query<Record<string, unknown>>(
    'SELECT CASE WHEN user_a = $2 THEN user_b ELSE user_a END AS "peerId" FROM direct_conversation WHERE id = $1 AND $2 IN (user_a, user_b)',
    [conversationId, userId],
  )
  if (!rows.rowCount) throw new DomainError(404, 'Conversation not found.')
  return z.object({ peerId: UserId }).parse(rows.rows[0])
}
export async function openDirect(userId: UserId, input: z.infer<typeof OpenDirect>) {
  return transaction(async (sql) => {
    await requireMember(sql, userId)
    if (input.userId === userId) throw new DomainError(400, 'You cannot message yourself.')
    const peer = await sql.query('SELECT 1 FROM member WHERE user_id = $1', [input.userId])
    if (!peer.rowCount) throw new DomainError(404, 'That person is not a member of this server.')
    // Sorted in SQL because the CHECK compares with the database collation, which orders mixed-case
    // IDs differently from JavaScript.
    await sql.query(
      'INSERT INTO direct_conversation(id, user_a, user_b) VALUES ($1, LEAST($2::text, $3::text), GREATEST($2::text, $3::text)) ON CONFLICT (user_a, user_b) DO NOTHING',
      [randomUUID(), userId, input.userId],
    )
    const rows = await sql.query<Record<string, unknown>>(
      `${conversationRows} AND $2 IN (c.user_a, c.user_b)`,
      [userId, input.userId],
    )
    return DirectConversation.parse(rows.rows[0])
  })
}
export async function directHistory(
  userId: UserId,
  conversationId: ConversationId,
  before?: string,
) {
  return transaction(async (sql) => {
    await requireMember(sql, userId)
    await requireConversation(sql, conversationId, userId)
    const messages = await sql.query<Record<string, unknown>>(
      `SELECT ${directColumns} FROM direct_message m WHERE m.conversation_id = $1 AND ($2::numeric IS NULL OR m.cursor < $2::numeric) ORDER BY m.cursor DESC LIMIT 100`,
      [conversationId, before ?? null],
    )
    return DirectMessage.array().parse(messages.rows).reverse()
  }, true)
}
export async function sendDirectMessage(
  user: { id: UserId; name: string; avatar: z.infer<typeof Avatar> },
  input: z.infer<typeof SendDirectMessage>,
) {
  return transaction(async (sql) => {
    await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [user.id])
    await lockServer(sql)
    await requireMember(sql, user.id)
    const { peerId } = await requireConversation(sql, input.conversationId, user.id)
    const duplicate = await sql.query<Record<string, unknown>>(
      `SELECT ${directColumns} FROM direct_message m WHERE m.author_id = $1 AND m.retry_id = $2`,
      [user.id, input.retryId],
    )
    if (duplicate.rowCount) {
      const message = DirectMessage.parse(duplicate.rows[0])
      if (message.body !== input.body || message.conversationId !== input.conversationId)
        throw new DomainError(409, 'This retry ID was already used for a different message.')
      return message
    }
    const participants: [UserId, UserId] = [user.id, peerId]
    const { message } = await appendEvent(
      sql,
      (cursor) => ({
        kind: 'direct.message.created',
        cursor,
        participants,
        message: {
          id: randomUUID(),
          ...input,
          authorId: user.id,
          authorName: user.name,
          authorAvatar: user.avatar,
          cursor,
          createdAt: new Date().toISOString(),
        },
      }),
      participants,
    )
    await sql.query(
      'INSERT INTO direct_message(id, conversation_id, author_id, author_name, retry_id, body, cursor, created_at, author_avatar) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        message.id,
        message.conversationId,
        message.authorId,
        message.authorName,
        message.retryId,
        message.body,
        message.cursor,
        message.createdAt,
        JSON.stringify(message.authorAvatar),
      ],
    )
    return message
  })
}
export async function markDirectRead(userId: UserId, input: z.infer<typeof MarkDirectRead>) {
  await transaction(async (sql) => {
    await requireMember(sql, userId)
    await requireConversation(sql, input.conversationId, userId)
    await sql.query(
      'INSERT INTO direct_read(user_id, conversation_id, cursor) SELECT $1, $2::uuid, LEAST($3::numeric, s.cursor) FROM server s ON CONFLICT (user_id, conversation_id) DO UPDATE SET cursor = GREATEST(direct_read.cursor, excluded.cursor)',
      [userId, input.conversationId, input.cursor],
    )
  })
}
export async function members(userId: UserId) {
  return transaction(async (sql) => {
    await requireMember(sql, userId)
    const rows = await sql.query<Record<string, unknown>>(
      `SELECT u.id, u.name, a.avatar, m.role,
        to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "joinedAt"
      FROM member m JOIN "user" u ON u.id = m.user_id
      JOIN account_security a ON a.user_id = u.id
      ORDER BY m.role = 'admin' DESC, m.created_at, u.id`,
    )
    return Members.parse({ members: rows.rows })
  }, true)
}
export async function voiceGrant(
  user: { id: UserId; name: string },
  input: z.infer<typeof JoinVoice>,
) {
  if (!config.voice) throw new DomainError(503, 'Voice is not set up on this server.')
  const { key, secret, url } = config.voice
  await transaction(async (sql) => {
    const channel = await findChannel(sql, input.channelId)
    await requireMember(sql, user.id)
    if (channel.kind === 'text') throw new DomainError(409, 'Text channels do not carry voice.')
  }, true)
  const token = new AccessToken(key, secret, { identity: user.id, name: user.name, ttl: 60 })
  token.addGrant({
    room: input.channelId,
    roomJoin: true,
    canSubscribe: true,
    canPublish: true,
    canPublishSources: [TrackSource.MICROPHONE],
    canPublishData: false,
    canUpdateOwnMetadata: false,
  })
  return VoiceGrant.parse({ url, token: await token.toJwt() })
}
async function findChannel(sql: PoolClient, channelId: ChannelId) {
  const rows = await sql.query<Record<string, unknown>>(
    `SELECT ${channelColumns} FROM channel WHERE id = $1`,
    [channelId],
  )
  if (!rows.rowCount) throw new DomainError(404, 'Channel not found.')
  return Channel.parse(rows.rows[0])
}
const replayPage = 100
export async function replay(userId: UserId, after: string) {
  return transaction(async (sql) => {
    await requireMember(sql, userId)
    const rows = await sql.query<Record<string, unknown>>(
      `SELECT event FROM event WHERE cursor > $1 AND (audience IS NULL OR $2 = ANY(audience))
        AND (group_id IS NULL OR event->>'kind' = 'group.removed' OR EXISTS
          (SELECT 1 FROM group_member gm WHERE gm.group_id = event.group_id AND gm.user_id = $2 AND event.cursor >= gm.admission)) ORDER BY cursor LIMIT ${replayPage}`,
      [after, userId],
    )
    const events = rows.rows.map((row) => ServerEvent.parse(row.event))
    const last = events.at(-1)
    if (last && events.length === replayPage) return { events, scanned: last.cursor }
    const head = await sql.query<Record<string, unknown>>('SELECT cursor::text FROM server')
    const { cursor } = z.object({ cursor: z.string() }).parse(head.rows[0])
    return { events, scanned: BigInt(cursor) > BigInt(after) ? cursor : after }
  }, true)
}

const groupColumns = `m.group_id AS "groupId", ${authoredColumns}`
const groupRows = `SELECT g.id, g.name, g.revision::text,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('userId', user_id, 'admission', admission::text) ORDER BY admission, user_id), '[]') FROM group_member WHERE group_id=g.id) AS members,
  to_jsonb(latest) AS latest, viewer.read_cursor::text AS "readCursor",
  (SELECT count(*)::integer FROM group_message u WHERE u.group_id=g.id AND u.author_id<>$1 AND u.cursor>viewer.read_cursor) AS unread
  FROM group_conversation g JOIN group_member viewer ON viewer.group_id=g.id AND viewer.user_id=$1
  LEFT JOIN LATERAL (SELECT ${groupColumns} FROM group_message m WHERE m.group_id=g.id ORDER BY m.cursor DESC LIMIT 1) latest ON true`
async function groupSummaries(sql: PoolClient, userId: UserId, id?: GroupId) {
  const rows = await sql.query<Record<string, unknown>>(
    `${groupRows} WHERE ($2::uuid IS NULL OR g.id=$2) ORDER BY coalesce(latest.cursor::bigint, g.revision) DESC`,
    [userId, id ?? null],
  )
  return GroupConversation.array().parse(rows.rows)
}
async function requireGroup(sql: PoolClient, userId: UserId, access: GroupAccess) {
  const rows = await sql.query(
    'SELECT 1 FROM group_member WHERE group_id=$1 AND user_id=$2 AND admission=$3::numeric',
    [access.groupId, userId, access.admission],
  )
  if (!rows.rowCount) throw new DomainError(404, 'Group not found.')
}
async function groupObservation(sql: PoolClient, userId: UserId, id: GroupId) {
  const group = (await groupSummaries(sql, userId, id))[0]
  if (!group) throw new DomainError(404, 'Group not found.')
  const head = await sql.query<Record<string, unknown>>('SELECT cursor::text FROM server')
  return { at: z.object({ cursor: z.string() }).parse(head.rows[0]).cursor, group }
}
async function validateGroupPeople(sql: PoolClient, ids: UserId[]) {
  const rows = await sql.query('SELECT user_id FROM member WHERE user_id=ANY($1::text[])', [ids])
  if (rows.rowCount !== ids.length)
    throw new DomainError(400, 'Choose people who belong to this server.')
}
async function publishGroup(sql: PoolClient, userId: UserId, id: GroupId) {
  const groups = await groupSummaries(sql, userId, id)
  const group = groups[0]
  if (!group) return
  const event = await appendEvent(
    sql,
    (cursor) => ({
      kind: 'group.changed',
      cursor,
      group: { ...GroupMetadata.parse(group), revision: cursor },
    }),
    group.members.map((m) => m.userId),
    id,
  )
  await sql.query('UPDATE group_conversation SET revision=$2 WHERE id=$1', [id, event.cursor])
}
export async function createGroup(userId: UserId, input: z.infer<typeof CreateGroup>) {
  return transaction(async (sql) => {
    await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [userId])
    await lockServer(sql)
    await requireMember(sql, userId)
    if (input.others.includes(userId)) throw new DomainError(400, 'You are included automatically.')
    const others = [...input.others].sort()
    const existing = await sql.query<Record<string, unknown>>(
      'SELECT id, name, create_others FROM group_conversation WHERE creator_id=$1 AND create_retry_id=$2',
      [userId, input.retryId],
    )
    if (existing.rowCount) {
      const old = z
        .object({ id: GroupId, name: z.string(), create_others: z.array(UserId) })
        .parse(existing.rows[0])
      const rows = await sql.query('SELECT 1 FROM group_member WHERE group_id=$1 AND user_id=$2', [
        old.id,
        userId,
      ])
      if (!rows.rowCount) throw new DomainError(404, 'Group not found.')
      if (old.name !== input.name || JSON.stringify(old.create_others) !== JSON.stringify(others))
        throw new DomainError(409, 'This retry ID was already used for a different group.')
      return groupObservation(sql, userId, old.id)
    }
    await validateGroupPeople(sql, others)
    const id = GroupId.parse(randomUUID())
    await sql.query(
      'INSERT INTO group_conversation(id,name,creator_id,create_retry_id,create_others) VALUES($1,$2,$3,$4,$5)',
      [id, input.name, userId, input.retryId, others],
    )
    await sql.query(
      'INSERT INTO group_member(group_id,user_id,admission,read_cursor) SELECT $1, unnest($2::text[]), cursor+1, cursor+1 FROM server',
      [id, [userId, ...others]],
    )
    await publishGroup(sql, userId, id)
    return groupObservation(sql, userId, id)
  })
}
export async function addGroupPeople(userId: UserId, input: z.infer<typeof AddGroupPeople>) {
  return transaction(async (sql) => {
    await lockServer(sql)
    await requireMember(sql, userId)
    await requireGroup(sql, userId, input)
    await validateGroupPeople(sql, input.userIds)
    const group = (await groupSummaries(sql, userId, input.groupId))[0]
    if (!group) throw new DomainError(404, 'Group not found.')
    const additions = input.userIds.filter((id) => !group.members.some((m) => m.userId === id))
    if (group.members.length + additions.length > 32)
      throw new DomainError(400, 'Groups can have up to 32 people.')
    if (additions.length) {
      await sql.query(
        'INSERT INTO group_member(group_id,user_id,admission,read_cursor) SELECT $1, unnest($2::text[]), cursor+1, cursor+1 FROM server',
        [input.groupId, additions],
      )
      await publishGroup(sql, userId, input.groupId)
    }
    return groupObservation(sql, userId, input.groupId)
  })
}
export async function leaveGroup(userId: UserId, access: GroupAccess) {
  return transaction(async (sql) => {
    await lockServer(sql)
    await requireMember(sql, userId)
    await requireGroup(sql, userId, access)
    await sql.query('DELETE FROM group_member WHERE group_id=$1 AND user_id=$2', [
      access.groupId,
      userId,
    ])
    const remaining = await sql.query<Record<string, unknown>>(
      'SELECT user_id FROM group_member WHERE group_id=$1 ORDER BY user_id',
      [access.groupId],
    )
    const first = z.object({ user_id: UserId }).array().parse(remaining.rows)[0]
    if (first) await publishGroup(sql, first.user_id, access.groupId)
    const event = await appendEvent(
      sql,
      (cursor) => ({ kind: 'group.removed', cursor, ...access }),
      [userId],
      access.groupId,
    )
    return { ...access, cursor: event.cursor }
  })
}
export async function groupHistory(userId: UserId, access: GroupAccess, before?: string) {
  return transaction(async (sql) => {
    await requireMember(sql, userId)
    await requireGroup(sql, userId, access)
    const rows = await sql.query<Record<string, unknown>>(
      `SELECT ${groupColumns} FROM group_message m WHERE m.group_id=$1 AND ($2::numeric IS NULL OR m.cursor<$2::numeric) ORDER BY m.cursor DESC LIMIT 100`,
      [access.groupId, before ?? null],
    )
    return GroupMessage.array().parse(rows.rows).reverse()
  }, true)
}
export async function sendGroupMessage(
  user: { id: UserId; name: string; avatar: z.infer<typeof Avatar> },
  input: z.infer<typeof SendGroupMessage>,
) {
  return transaction(async (sql) => {
    await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [user.id])
    await lockServer(sql)
    await requireMember(sql, user.id)
    await requireGroup(sql, user.id, input)
    const duplicates = await sql.query<Record<string, unknown>>(
      `SELECT ${groupColumns}, m.author_admission::text AS admission FROM group_message m WHERE m.author_id=$1 AND m.retry_id=$2`,
      [user.id, input.retryId],
    )
    if (duplicates.rowCount) {
      const old = GroupMessage.extend({ admission: Admission }).parse(duplicates.rows[0])
      if (
        old.groupId !== input.groupId ||
        old.admission !== input.admission ||
        old.body !== input.body
      )
        throw new DomainError(409, 'This retry ID was already used for a different message.')
      return GroupMessage.parse(old)
    }
    const members = await sql.query<Record<string, unknown>>(
      'SELECT user_id FROM group_member WHERE group_id=$1',
      [input.groupId],
    )
    const audience = z
      .object({ user_id: UserId })
      .array()
      .parse(members.rows)
      .map((m) => m.user_id)
    const { message } = await appendEvent(
      sql,
      (cursor) => ({
        kind: 'group.message.created',
        cursor,
        message: {
          id: randomUUID(),
          groupId: input.groupId,
          retryId: input.retryId,
          body: input.body,
          authorId: user.id,
          authorName: user.name,
          authorAvatar: user.avatar,
          cursor,
          createdAt: new Date().toISOString(),
        },
      }),
      audience,
      input.groupId,
    )
    await sql.query(
      'INSERT INTO group_message(id,group_id,author_id,author_admission,author_name,author_avatar,retry_id,body,cursor,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [
        message.id,
        message.groupId,
        user.id,
        input.admission,
        user.name,
        JSON.stringify(user.avatar),
        message.retryId,
        message.body,
        message.cursor,
        message.createdAt,
      ],
    )
    return message
  })
}
export async function markGroupRead(userId: UserId, input: z.infer<typeof MarkGroupRead>) {
  await transaction(async (sql) => {
    await lockServer(sql)
    await requireMember(sql, userId)
    await requireGroup(sql, userId, input)
    await sql.query(
      'UPDATE group_member SET read_cursor=GREATEST(read_cursor,LEAST($3::numeric,(SELECT cursor FROM server))) WHERE group_id=$1 AND user_id=$2',
      [input.groupId, userId, input.cursor],
    )
  })
}
