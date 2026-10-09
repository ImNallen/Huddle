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
  UserId,
  Workspace,
  WorkspaceEvent,
  type ChannelId,
  type WorkspaceId,
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
const roomColumns = 'id, workspace_id AS "workspaceId", name'
const channelColumns = 'id, workspace_id AS "workspaceId", room_id AS "roomId", name'
const messageColumns =
  'm.id, m.channel_id AS "channelId", m.author_id AS "authorId", m.author_name AS "authorName", m.author_avatar AS "authorAvatar", m.retry_id AS "retryId", m.body, m.cursor::text, to_char(m.created_at AT TIME ZONE \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"\') AS "createdAt"'
const unreadMessages =
  'message m JOIN channel c ON c.id = m.channel_id LEFT JOIN channel_read r ON r.channel_id = c.id AND r.user_id = $2 WHERE c.workspace_id = $1 AND m.cursor > coalesce(r.cursor, 0)'

async function transaction<T>(
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
  workspaceId: WorkspaceId,
  owner = false,
) {
  const result = await sql.query<Record<string, unknown>>(
    'SELECT w.id, w.name, m.role, (SELECT count(*)::integer FROM membership WHERE workspace_id=w.id) AS "memberCount", (SELECT count(*)::integer FROM channel WHERE workspace_id=w.id) AS "channelCount" FROM workspace w JOIN membership m ON m.workspace_id = w.id WHERE w.id = $1 AND m.user_id = $2',
    [workspaceId, userId],
  )
  if (!result.rowCount) throw new DomainError(403, 'You do not have access to this workspace.')
  const workspace = Workspace.parse(result.rows[0])
  if (owner && workspace.role !== 'owner')
    throw new DomainError(403, 'Only a workspace owner can do that.')
  return workspace
}
async function lockWorkspace(sql: PoolClient, workspaceId: WorkspaceId) {
  await sql.query('SELECT id FROM workspace WHERE id = $1 FOR UPDATE', [workspaceId])
}
async function appendEvent<T extends z.infer<typeof WorkspaceEvent>>(
  sql: PoolClient,
  workspaceId: WorkspaceId,
  makeEvent: (cursor: string) => T,
) {
  const result = await sql.query<Record<string, unknown>>(
    'UPDATE workspace SET cursor = cursor + 1 WHERE id = $1 RETURNING cursor::text',
    [workspaceId],
  )
  const { cursor } = z.object({ cursor: z.string() }).parse(result.rows[0])
  const event = makeEvent(cursor)
  await sql.query('INSERT INTO workspace_event(workspace_id, cursor, event) VALUES ($1, $2, $3)', [
    workspaceId,
    cursor,
    event,
  ])
  await sql.query("SELECT pg_notify('huddle_commit', $1)", [workspaceId])
  return event
}
export async function listWorkspaces(userId: UserId) {
  const result = await db.query<Record<string, unknown>>(
    'SELECT w.id, w.name, m.role, (SELECT count(*)::integer FROM membership WHERE workspace_id=w.id) AS "memberCount", (SELECT count(*)::integer FROM channel WHERE workspace_id=w.id) AS "channelCount" FROM workspace w JOIN membership m ON w.id = m.workspace_id WHERE m.user_id = $1 ORDER BY w.name, w.id',
    [userId],
  )
  return Workspace.array().parse(result.rows)
}
export async function createWorkspace(userId: UserId, name: string) {
  const workspace = Workspace.parse({
    id: randomUUID(),
    name,
    role: 'owner',
    memberCount: 1,
    channelCount: 0,
  })
  await transaction(async (sql) => {
    await sql.query('INSERT INTO workspace(id, name) VALUES ($1, $2)', [workspace.id, name])
    await sql.query(
      "INSERT INTO membership(workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
      [workspace.id, userId],
    )
  })
  return workspace
}
export async function snapshot(userId: UserId, workspaceId: WorkspaceId) {
  return transaction(async (sql) => {
    const workspace = await requireMember(sql, userId, workspaceId)
    const rooms = await sql.query<Record<string, unknown>>(
      `SELECT ${roomColumns} FROM room WHERE workspace_id = $1 ORDER BY lower(name), id`,
      [workspaceId],
    )
    const channels = await sql.query<Record<string, unknown>>(
      `SELECT ${channelColumns} FROM channel WHERE workspace_id = $1 ORDER BY name, id`,
      [workspaceId],
    )
    const unread = await sql.query<Record<string, unknown>>(
      `SELECT m.channel_id AS "channelId", count(*)::integer AS count FROM ${unreadMessages} AND m.author_id <> $2 GROUP BY m.channel_id ORDER BY m.channel_id`,
      [workspaceId, userId],
    )
    const cursorRows = await sql.query<Record<string, unknown>>(
      'SELECT cursor::text FROM workspace WHERE id = $1',
      [workspaceId],
    )
    const { cursor } = z.object({ cursor: z.string() }).parse(cursorRows.rows[0])
    return {
      workspace,
      rooms: Room.array().parse(rooms.rows),
      channels: Channel.array().parse(channels.rows),
      unread: Unread.array().parse(unread.rows),
      cursor,
    }
  }, true)
}
export async function createRoom(userId: UserId, input: z.infer<typeof CreateRoom>) {
  const room = Room.parse({ id: randomUUID(), ...input })
  await transaction(async (sql) => {
    await lockWorkspace(sql, room.workspaceId)
    await requireMember(sql, userId, room.workspaceId, true)
    await sql.query('INSERT INTO room(id, workspace_id, name) VALUES ($1, $2, $3)', [
      room.id,
      room.workspaceId,
      room.name,
    ])
    await appendEvent(sql, room.workspaceId, (cursor) => ({ kind: 'room.created', room, cursor }))
  })
  return room
}
export async function createChannel(userId: UserId, input: z.infer<typeof CreateChannel>) {
  return transaction(async (sql) => {
    const rows = await sql.query<Record<string, unknown>>(
      `SELECT ${roomColumns} FROM room WHERE id = $1`,
      [input.roomId],
    )
    if (!rows.rowCount) throw new DomainError(404, 'Room not found.')
    const room = Room.parse(rows.rows[0])
    const channel = Channel.parse({ id: randomUUID(), workspaceId: room.workspaceId, ...input })
    await lockWorkspace(sql, room.workspaceId)
    await requireMember(sql, userId, room.workspaceId, true)
    await sql.query(
      'INSERT INTO channel(id, workspace_id, room_id, name) VALUES ($1, $2, $3, $4)',
      [channel.id, channel.workspaceId, channel.roomId, channel.name],
    )
    await appendEvent(sql, channel.workspaceId, (cursor) => ({
      kind: 'channel.created',
      channel,
      cursor,
    }))
    return channel
  })
}
export async function history(userId: UserId, channelId: ChannelId, before?: string) {
  return transaction(async (sql) => {
    const channel = await findChannel(sql, channelId)
    await requireMember(sql, userId, channel.workspaceId)
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
  const result = await transaction(async (sql) => {
    await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [user.id])
    const channel = await findChannel(sql, input.channelId)
    await lockWorkspace(sql, channel.workspaceId)
    await requireMember(sql, user.id, channel.workspaceId)
    const duplicate = await sql.query<Record<string, unknown>>(
      `SELECT ${messageColumns} FROM message m WHERE m.author_id = $1 AND m.retry_id = $2`,
      [user.id, input.retryId],
    )
    if (duplicate.rowCount) {
      const message = Message.parse(duplicate.rows[0])
      if (message.body !== input.body || message.channelId !== input.channelId)
        throw new DomainError(409, 'This retry ID was already used for a different message.')
      return { message, workspaceId: channel.workspaceId }
    }
    const { message } = await appendEvent(sql, channel.workspaceId, (cursor) => ({
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
      'SELECT u.id, u.name FROM membership m JOIN "user" u ON u.id = m.user_id WHERE m.workspace_id = $1',
      [channel.workspaceId],
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
    return { message, workspaceId: channel.workspaceId }
  })
  return result.message
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
    const workspaceId =
      input.kind === 'workspace'
        ? input.workspaceId
        : (await findChannel(sql, input.channelId)).workspaceId
    await requireMember(sql, userId, workspaceId)
    await sql.query(
      'INSERT INTO channel_read(user_id, channel_id, cursor) SELECT $1, c.id, LEAST($4::numeric, w.cursor) FROM channel c JOIN workspace w ON w.id = c.workspace_id WHERE c.workspace_id = $2 AND ($3::uuid IS NULL OR c.id = $3) ON CONFLICT (user_id, channel_id) DO UPDATE SET cursor = GREATEST(channel_read.cursor, excluded.cursor)',
      [userId, workspaceId, input.kind === 'channel' ? input.channelId : null, input.cursor],
    )
  })
}
export async function home(userId: UserId, workspaceId: WorkspaceId) {
  return transaction(async (sql) => {
    await requireMember(sql, userId, workspaceId)
    const mentions = await sql.query<Record<string, unknown>>(
      `SELECT ${messageColumns} FROM ${unreadMessages} AND EXISTS (SELECT 1 FROM message_mention mm WHERE mm.message_id = m.id AND mm.user_id = $2) ORDER BY m.cursor DESC LIMIT 50`,
      [workspaceId, userId],
    )
    const channels = await sql.query<Record<string, unknown>>(
      `WITH unread AS (SELECT m.*, count(*) OVER (PARTITION BY m.channel_id) AS count, row_number() OVER (PARTITION BY m.channel_id ORDER BY m.cursor DESC) AS rank FROM ${unreadMessages} AND m.author_id <> $2) SELECT ${messageColumns}, m.count::integer AS count FROM unread m WHERE m.rank = 1 ORDER BY m.cursor DESC LIMIT 50`,
      [workspaceId, userId],
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
export async function createInvitation(userId: UserId, workspaceId: WorkspaceId) {
  const code = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + 86400000).toISOString()
  await transaction(async (sql) => {
    await lockWorkspace(sql, workspaceId)
    await requireMember(sql, userId, workspaceId, true)
    await sql.query(
      'INSERT INTO invitation(code_hash, workspace_id, expires_at) VALUES ($1,$2,$3)',
      [hash(code), workspaceId, expiresAt],
    )
  })
  return { code, expiresAt }
}
const hash = (code: string) => createHash('sha256').update(code).digest('hex')
export async function redeemInvitation(userId: UserId, code: string) {
  return transaction(async (sql) => {
    const rows = await sql.query<Record<string, unknown>>(
      'SELECT workspace_id AS "workspaceId" FROM invitation WHERE code_hash = $1 AND consumed_at IS NULL AND expires_at > now() FOR UPDATE',
      [hash(code)],
    )
    if (!rows.rowCount)
      throw new DomainError(404, 'Invitation is invalid, expired, or already used.')
    const { workspaceId } = Channel.pick({ workspaceId: true }).parse(rows.rows[0])
    await lockWorkspace(sql, workspaceId)
    await sql.query(
      "INSERT INTO membership(workspace_id, user_id, role) VALUES ($1,$2,'member') ON CONFLICT DO NOTHING",
      [workspaceId, userId],
    )
    await sql.query(
      'UPDATE invitation SET consumed_by = $1, consumed_at = now() WHERE code_hash = $2',
      [userId, hash(code)],
    )
    return requireMember(sql, userId, workspaceId)
  })
}
export async function replay(userId: UserId, workspaceId: WorkspaceId, after: string) {
  return transaction(async (sql) => {
    await requireMember(sql, userId, workspaceId)
    const rows = await sql.query<Record<string, unknown>>(
      'SELECT event FROM workspace_event WHERE workspace_id = $1 AND cursor > $2 ORDER BY cursor LIMIT 100',
      [workspaceId, after],
    )
    return rows.rows.map((row) => WorkspaceEvent.parse(row.event))
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
