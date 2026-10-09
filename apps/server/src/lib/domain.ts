import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import {
  Avatar,
  Channel,
  Message,
  Workspace,
  WorkspaceEvent,
  type ChannelId,
  type UserId,
  type WorkspaceId,
  type SendMessage,
  type CreateChannel,
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
const channelColumns = 'id, workspace_id AS "workspaceId", name'
const messageColumns =
  'id, channel_id AS "channelId", author_id AS "authorId", author_name AS "authorName", author_avatar AS "authorAvatar", retry_id AS "retryId", body, cursor::text, to_char(created_at AT TIME ZONE \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"\') AS "createdAt"'

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
    const rows = await sql.query<Record<string, unknown>>(
      `SELECT ${channelColumns} FROM channel WHERE workspace_id = $1 ORDER BY name`,
      [workspaceId],
    )
    const cursorRows = await sql.query<Record<string, unknown>>(
      'SELECT cursor::text FROM workspace WHERE id = $1',
      [workspaceId],
    )
    const { cursor } = z.object({ cursor: z.string() }).parse(cursorRows.rows[0])
    return { workspace, channels: Channel.array().parse(rows.rows), cursor }
  }, true)
}
export async function createChannel(userId: UserId, input: z.infer<typeof CreateChannel>) {
  const channel = Channel.parse({ id: randomUUID(), ...input })
  await transaction(async (sql) => {
    await lockWorkspace(sql, input.workspaceId)
    await requireMember(sql, userId, input.workspaceId, true)
    await sql.query('INSERT INTO channel(id, workspace_id, name) VALUES ($1, $2, $3)', [
      channel.id,
      channel.workspaceId,
      channel.name,
    ])
    await appendEvent(sql, channel.workspaceId, (cursor) => ({
      kind: 'channel.created',
      channel,
      cursor,
    }))
  })
  return channel
}
export async function history(userId: UserId, channelId: ChannelId, before?: string) {
  return transaction(async (sql) => {
    const rows = await sql.query<Record<string, unknown>>(
      `SELECT ${channelColumns} FROM channel WHERE id = $1`,
      [channelId],
    )
    if (!rows.rowCount) throw new DomainError(404, 'Channel not found.')
    const channel = Channel.parse(rows.rows[0])
    await requireMember(sql, userId, channel.workspaceId)
    const messages = await sql.query<Record<string, unknown>>(
      `SELECT ${messageColumns} FROM message WHERE channel_id = $1 AND ($2::bigint IS NULL OR cursor < $2::bigint) ORDER BY cursor DESC LIMIT 100`,
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
    const rows = await sql.query<Record<string, unknown>>(
      `SELECT ${channelColumns} FROM channel WHERE id = $1`,
      [input.channelId],
    )
    if (!rows.rowCount) throw new DomainError(404, 'Channel not found.')
    const channel = Channel.parse(rows.rows[0])
    await lockWorkspace(sql, channel.workspaceId)
    await requireMember(sql, user.id, channel.workspaceId)
    const duplicate = await sql.query<Record<string, unknown>>(
      `SELECT ${messageColumns} FROM message WHERE author_id = $1 AND retry_id = $2`,
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
    return { message, workspaceId: channel.workspaceId }
  })
  return result.message
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
