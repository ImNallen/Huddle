import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import {
  Avatar,
  Channel,
  Home,
  Message,
  Room,
  Unread,
  Server,
  ServerEvent,
  UserId,
  type ChannelId,
  type SendMessage,
  type CreateChannel,
  type CreateRoom,
  type MarkRead,
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
const channelColumns = 'id, room_id AS "roomId", name'
const messageColumns =
  'm.id, m.channel_id AS "channelId", m.author_id AS "authorId", m.author_name AS "authorName", m.author_avatar AS "authorAvatar", m.retry_id AS "retryId", m.body, m.cursor::text, to_char(m.created_at AT TIME ZONE \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"\') AS "createdAt"'
const unreadMessages =
  'message m LEFT JOIN channel_read r ON r.channel_id = m.channel_id AND r.user_id = $1 WHERE m.cursor > coalesce(r.cursor, 0)'

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
) {
  const result = await sql.query<Record<string, unknown>>(
    'UPDATE server SET cursor = cursor + 1 RETURNING cursor::text',
  )
  const { cursor } = z.object({ cursor: z.string() }).parse(result.rows[0])
  const event = makeEvent(cursor)
  await sql.query('INSERT INTO event(cursor, event) VALUES ($1, $2)', [cursor, event])
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
      `SELECT m.channel_id AS "channelId", count(*)::integer AS count FROM ${unreadMessages} AND m.author_id <> $1 GROUP BY m.channel_id ORDER BY m.channel_id`,
      [userId],
    )
    const cursorRows = await sql.query<Record<string, unknown>>('SELECT cursor::text FROM server')
    const { cursor } = z.object({ cursor: z.string() }).parse(cursorRows.rows[0])
    return {
      server,
      rooms: Room.array().parse(rooms.rows),
      channels: Channel.array().parse(channels.rows),
      unread: Unread.array().parse(unread.rows),
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
    await appendEvent(sql, (cursor) => ({ kind: 'room.created', room, cursor }))
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
    await sql.query('INSERT INTO channel(id, room_id, name) VALUES ($1, $2, $3)', [
      channel.id,
      channel.roomId,
      channel.name,
    ])
    await appendEvent(sql, (cursor) => ({
      kind: 'channel.created',
      channel,
      cursor,
    }))
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
    await findChannel(sql, input.channelId)
    await lockServer(sql)
    await requireMember(sql, user.id)
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
    const { message } = await appendEvent(sql, (cursor) => ({
      kind: 'message.created',
      cursor,
      message: {
        id: randomUUID(),
        ...input,
        authorId: user.id,
        authorName: user.name,
        authorAvatar: user.avatar,
        cursor,
        createdAt: new Date().toISOString(),
      },
    }))
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
    const members = await sql.query<Record<string, unknown>>(
      'SELECT u.id, u.name FROM member m JOIN "user" u ON u.id = m.user_id',
    )
    const mentioned = mentionedUsers(
      message.body,
      z.object({ id: UserId, name: z.string() }).array().parse(members.rows),
      user.id,
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
    if (input.kind === 'channel') await findChannel(sql, input.channelId)
    await requireMember(sql, userId)
    await sql.query(
      'INSERT INTO channel_read(user_id, channel_id, cursor) SELECT $1, c.id, LEAST($3::numeric, s.cursor) FROM channel c CROSS JOIN server s WHERE ($2::uuid IS NULL OR c.id = $2) ON CONFLICT (user_id, channel_id) DO UPDATE SET cursor = GREATEST(channel_read.cursor, excluded.cursor)',
      [userId, input.kind === 'channel' ? input.channelId : null, input.cursor],
    )
  })
}
export async function home(userId: UserId) {
  return transaction(async (sql) => {
    await requireMember(sql, userId)
    const mentions = await sql.query<Record<string, unknown>>(
      `SELECT ${messageColumns} FROM ${unreadMessages} AND EXISTS (SELECT 1 FROM message_mention mm WHERE mm.message_id = m.id AND mm.user_id = $1) ORDER BY m.cursor DESC LIMIT 50`,
      [userId],
    )
    const channels = await sql.query<Record<string, unknown>>(
      `WITH unread AS (SELECT m.*, count(*) OVER (PARTITION BY m.channel_id) AS count, row_number() OVER (PARTITION BY m.channel_id ORDER BY m.cursor DESC) AS rank FROM ${unreadMessages} AND m.author_id <> $1) SELECT ${messageColumns}, m.count::integer AS count FROM unread m WHERE m.rank = 1 ORDER BY m.cursor DESC LIMIT 50`,
      [userId],
    )
    return Home.parse({
      items: [
        ...mentions.rows.map((row) => ({ kind: 'mention', message: row })),
        ...channels.rows.map((row) => ({
          kind: 'channel',
          channelId: row.channelId,
          count: row.count,
          latest: row,
        })),
      ],
    })
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
export async function replay(userId: UserId, after: string) {
  return transaction(async (sql) => {
    await requireMember(sql, userId)
    const rows = await sql.query<Record<string, unknown>>(
      'SELECT event FROM event WHERE cursor > $1 ORDER BY cursor LIMIT 100',
      [after],
    )
    return rows.rows.map((row) => ServerEvent.parse(row.event))
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
    'WITH claimed AS (DELETE FROM watch_ticket WHERE hash = $1 AND expires_at > now() RETURNING session_id) SELECT s.token FROM session s JOIN claimed ON claimed.session_id = s.id JOIN session_proof p ON p.session_id=s.id JOIN account_security a ON a.user_id=p.user_id AND a.epoch=p.epoch WHERE s."expiresAt">now() AND p.stage=\'ready\'',
    [hash(ticket)],
  )
  return z.object({ token: z.string() }).parse(result.rows[0]).token
}
