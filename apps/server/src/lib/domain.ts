import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import {
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
  type ChannelId,
  type ConversationId,
  type SendMessage,
  type SendDirectMessage,
  type CreateChannel,
  type CreateRoom,
  type MarkRead,
  type MarkDirectRead,
  type OpenDirect,
} from '@huddle/contracts'
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
) {
  const result = await sql.query<Record<string, unknown>>(
    'UPDATE server SET cursor = cursor + 1 RETURNING cursor::text',
  )
  const { cursor } = z.object({ cursor: z.string() }).parse(result.rows[0])
  const event = makeEvent(cursor)
  await sql.query('INSERT INTO event(cursor, event, audience) VALUES ($1, $2, $3)', [
    cursor,
    event,
    audience === 'everyone' ? null : audience,
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
async function findChannel(sql: PoolClient, channelId: ChannelId) {
  const rows = await sql.query<Record<string, unknown>>(
    `SELECT ${channelColumns} FROM channel WHERE id = $1`,
    [channelId],
  )
  if (!rows.rowCount) throw new DomainError(404, 'Channel not found.')
  return Channel.parse(rows.rows[0])
}
const hash = (code: string) => createHash('sha256').update(code).digest('hex')
const replayPage = 100
export async function replay(userId: UserId, after: string) {
  return transaction(async (sql) => {
    await requireMember(sql, userId)
    const rows = await sql.query<Record<string, unknown>>(
      `SELECT event FROM event WHERE cursor > $1 AND (audience IS NULL OR $2 = ANY(audience)) ORDER BY cursor LIMIT ${replayPage}`,
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

export async function createWatchTicket(sessionId: string) {
  const ticket = randomBytes(32).toString('base64url')
  await db.query('DELETE FROM watch_ticket WHERE expires_at < now()')
  await db.query(
    "INSERT INTO watch_ticket(hash, session_id, expires_at) VALUES ($1,$2,now() + interval '30 seconds')",
    [hash(ticket), sessionId],
  )
  return { ticket }
}
export async function consumeWatchTicket(ticket: string) {
  const result = await db.query<Record<string, unknown>>(
    'WITH claimed AS (DELETE FROM watch_ticket WHERE hash = $1 AND expires_at > now() RETURNING session_id) SELECT s.token FROM session s JOIN claimed ON claimed.session_id = s.id WHERE s."expiresAt">now()',
    [hash(ticket)],
  )
  return z.object({ token: z.string() }).parse(result.rows[0]).token
}
