import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk'
import type { PoolClient } from 'pg'
import {
  DirectCall,
  VoiceGrant,
  CallId,
  type ConversationId,
  type UserId,
  type DirectCallEndReason,
} from '@huddle/contracts'
import { config } from './config'
import { db } from './db'
import { DomainError, lockServer, requireConversation, transaction } from './domain'

const columns = `c.id, c.conversation_id AS "conversationId", c.caller_id AS "callerId",
  c.callee_id AS "calleeId", a.name AS "callerName", b.name AS "calleeName", c.state,
  c.revision::float8 AS revision,
  to_char(c.deadline AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS deadline, c.reason`
const rows = `SELECT ${columns} FROM direct_call c JOIN "user" a ON a.id=c.caller_id JOIN "user" b ON b.id=c.callee_id`
async function roomName(sql: Pick<PoolClient, 'query'>, id: CallId): Promise<string> {
  const row = await sql.query<{ room_name: string }>(
    'SELECT room_name FROM direct_call WHERE id=$1',
    [id],
  )
  const name = row.rows[0]?.room_name
  if (!name) throw missing()
  return name
}
const missing = () => new DomainError(404, 'Call not found.')

async function end(sql: PoolClient, id: CallId, reason: DirectCallEndReason) {
  await sql.query(
    `UPDATE direct_call SET state='ended', reason=$2,
    revision=nextval('direct_call_revision') WHERE id=$1 AND state<>'ended'`,
    [id, reason],
  )
}
async function expire(sql: PoolClient) {
  await sql.query(`UPDATE direct_call c SET state='ended',
    reason=CASE WHEN NOT EXISTS (SELECT 1 FROM member WHERE user_id=c.caller_id)
      OR NOT EXISTS (SELECT 1 FROM member WHERE user_id=c.callee_id) THEN 'access-lost'
      WHEN state='accepted' THEN 'join-timeout' ELSE 'timeout' END, revision=nextval('direct_call_revision')
    WHERE state<>'ended' AND (((state='ringing' OR (state='accepted' AND NOT media_joined)) AND deadline<=clock_timestamp())
      OR NOT EXISTS (SELECT 1 FROM member WHERE user_id=c.caller_id)
      OR NOT EXISTS (SELECT 1 FROM member WHERE user_id=c.callee_id))`)
}
async function find(sql: PoolClient, id: CallId, userId: UserId) {
  const found = await sql.query(`${rows} WHERE c.id=$1 AND $2 IN(c.caller_id,c.callee_id)`, [
    id,
    userId,
  ])
  if (!found.rowCount) throw missing()
  const call = DirectCall.parse(found.rows[0])
  await requireConversation(sql, call.conversationId, userId)
  const members = await sql.query('SELECT 1 FROM member WHERE user_id=ANY($1::text[])', [
    [call.callerId, call.calleeId],
  ])
  if (members.rowCount !== 2) throw missing()
  return call
}
async function locked<T>(operation: (sql: PoolClient) => Promise<T>) {
  return transaction(async (sql) => {
    await lockServer(sql)
    await expire(sql)
    return operation(sql)
  })
}
export async function currentDirectCall(userId: UserId) {
  const found = await db.query(
    `${rows} WHERE $1 IN(c.caller_id,c.callee_id) ORDER BY c.revision DESC LIMIT 1`,
    [userId],
  )
  return found.rowCount ? DirectCall.parse(found.rows[0]) : null
}
export async function startDirectCall(
  userId: UserId,
  input: { callId: CallId; conversationId: ConversationId },
) {
  if (!config.voice) throw new DomainError(503, 'Voice is not set up on this server.')
  return locked(async (sql) => {
    const { peerId } = await requireConversation(sql, input.conversationId, userId)
    const members = await sql.query('SELECT 1 FROM member WHERE user_id=ANY($1::text[])', [
      [userId, peerId],
    ])
    if (members.rowCount !== 2) throw missing()
    const prior = await sql.query('SELECT 1 FROM direct_call WHERE id=$1', [input.callId])
    if (prior.rowCount) {
      const call = await find(sql, input.callId, userId)
      if (call.callerId !== userId || call.conversationId !== input.conversationId)
        throw new DomainError(409, 'That call attempt was already used.')
      return call
    }
    const busy = await sql.query(
      `SELECT 1 FROM direct_call WHERE state<>'ended'
      AND (caller_id=ANY($1::text[]) OR callee_id=ANY($1::text[]))`,
      [[userId, peerId]],
    )
    if (busy.rowCount) throw new DomainError(409, 'One of you is already in a private call.')
    await sql.query(
      `INSERT INTO direct_call(id,conversation_id,caller_id,callee_id,state,deadline)
      VALUES($1,$2,$3,$4,'ringing',clock_timestamp()+$5*interval '1 second')`,
      [input.callId, input.conversationId, userId, peerId, config.DIRECT_CALL_RING_SECONDS],
    )
    return find(sql, input.callId, userId)
  })
}
export async function acceptDirectCall(userId: UserId, id: CallId) {
  return locked(async (sql) => {
    const call = await find(sql, id, userId)
    if (call.calleeId !== userId) throw new DomainError(409, 'Only the recipient can answer.')
    if (call.state === 'ringing')
      await sql.query(
        `UPDATE direct_call SET state='accepted',
      deadline=clock_timestamp()+$2*interval '1 second', revision=nextval('direct_call_revision') WHERE id=$1`,
        [id, config.DIRECT_CALL_JOIN_SECONDS],
      )
    return find(sql, id, userId)
  })
}
export async function endDirectCall(
  userId: UserId,
  id: CallId,
  action: 'decline' | 'cancel' | 'hangup',
) {
  return locked(async (sql) => {
    const call = await find(sql, id, userId)
    if (
      (action === 'decline' && userId !== call.calleeId) ||
      (action === 'cancel' && userId !== call.callerId)
    )
      throw new DomainError(409, 'That action belongs to the other person.')
    if (call.state !== 'ended') {
      if (action === 'decline' && call.state !== 'ringing')
        throw new DomainError(409, 'The call was already answered.')
      await end(
        sql,
        id,
        action === 'decline' ? 'declined' : action === 'cancel' ? 'cancelled' : 'hangup',
      )
    }
    return find(sql, id, userId)
  })
}
export async function directCallGrant(user: { id: UserId; name: string }, id: CallId) {
  const voice = config.voice
  if (!voice) throw new DomainError(503, 'Voice is not set up on this server.')
  return locked(async (sql) => {
    const call = await find(sql, id, user.id)
    if (call.state !== 'accepted') throw new DomainError(409, 'This call is not accepted.')
    const token = new AccessToken(voice.key, voice.secret, {
      identity: user.id,
      name: user.name,
      ttl: 60,
    })
    token.addGrant({
      room: await roomName(sql, id),
      roomJoin: true,
      canSubscribe: true,
      canPublish: true,
      canPublishSources: [TrackSource.MICROPHONE],
      canPublishData: false,
      canUpdateOwnMetadata: false,
    })
    const jwt = await token.toJwt()
    await sql.query(
      `UPDATE direct_call SET token_expires_at=GREATEST(token_expires_at,clock_timestamp()+interval '65 seconds') WHERE id=$1`,
      [id],
    )
    return VoiceGrant.parse({ url: voice.url, token: jwt })
  })
}

export async function startDirectCalls() {
  await locked(async (sql) => {
    await sql.query(
      `UPDATE direct_call SET state='ended',reason='restart',revision=nextval('direct_call_revision') WHERE state<>'ended'`,
    )
  })
  const voice = config.voice
  if (!voice) return { watching: (_id: UserId) => () => {}, close() {} }
  const service = new RoomServiceClient(voice.adminUrl, voice.key, voice.secret, {
    requestTimeout: 5,
  })
  const watchers = new Map<UserId, number>()
  const watchingLost = new Map<UserId, number>()
  const media = new Map<CallId, { joined: boolean; missingSince: number | null }>()
  let stopped = false
  let timer: NodeJS.Timeout | undefined
  async function endObserved(call: DirectCall, reason: DirectCallEndReason) {
    await locked(async (sql) => {
      await sql.query(
        `UPDATE direct_call SET state='ended', reason=$3,
        revision=nextval('direct_call_revision') WHERE id=$1 AND revision=$2 AND state<>'ended'`,
        [call.id, call.revision, reason],
      )
    })
  }
  async function look() {
    const active = await locked(async (sql) =>
      DirectCall.array().parse((await sql.query(`${rows} WHERE c.state<>'ended'`)).rows),
    )
    const now = Date.now()
    const activeIds = new Set(active.map((call) => call.id))
    for (const id of media.keys()) if (!activeIds.has(id)) media.delete(id)
    const present: DirectCall[] = []
    for (const call of active) {
      let lost = false
      for (const id of [call.callerId, call.calleeId]) {
        if (watchers.has(id)) watchingLost.delete(id)
        else if (!watchingLost.has(id)) watchingLost.set(id, now)
        const since = watchingLost.get(id)
        if (since !== undefined && now - since >= config.VOICE_ACCESS_GRACE_SECONDS * 1000)
          lost = true
      }
      if (lost) await endObserved(call, 'access-lost')
      else present.push(call)
    }
    for (const id of watchingLost.keys())
      if (!active.some((c) => c.callerId === id || c.calleeId === id)) watchingLost.delete(id)

    const rooms = await service.listRooms()
    const names = new Set(rooms.map(({ name }) => name))
    for (const call of present) {
      if (call.state !== 'accepted') continue
      const name = await roomName(db, call.id)
      const people = names.has(name)
        ? await service.listParticipants(name).catch((error: unknown) => {
            if (error instanceof Error && 'code' in error && error.code === 'not_found') return []
            throw error
          })
        : []
      const both = [call.callerId, call.calleeId].every((id) =>
        people.some((person) => person.identity === id),
      )
      const seen = media.get(call.id) ?? { joined: false, missingSince: null }
      if (both) {
        seen.joined = true
        seen.missingSince = null
        await locked(async (sql) => {
          await sql.query(
            "UPDATE direct_call SET media_joined=true WHERE id=$1 AND revision=$2 AND state='accepted'",
            [call.id, call.revision],
          )
        })
      } else if (!seen.joined && now >= Date.parse(call.deadline))
        await endObserved(call, 'join-timeout')
      else if (seen.joined) {
        seen.missingSince ??= now
        if (now - seen.missingSince >= 15000) await endObserved(call, 'disconnected')
      }
      media.set(call.id, seen)
    }
    const ended = await db.query<{ room_name: string }>(
      "SELECT room_name FROM direct_call WHERE state='ended' AND room_name=ANY($1::text[])",
      [[...names]],
    )
    for (const { room_name: name } of ended.rows)
      await service.deleteRoom(name).catch((error: unknown) => {
        if (!(error instanceof Error && 'code' in error && error.code === 'not_found')) throw error
      })
  }
  async function loop() {
    try {
      await look()
    } catch (error) {
      console.error({ event: 'direct.calls.reconcile.failed', error })
    }
    if (!stopped) timer = setTimeout(() => void loop(), 1000)
  }
  void loop()
  return {
    watching(id: UserId) {
      watchers.set(id, (watchers.get(id) ?? 0) + 1)
      watchingLost.delete(id)
      return () => {
        const count = (watchers.get(id) ?? 1) - 1
        if (count) watchers.set(id, count)
        else watchers.delete(id)
      }
    },
    close() {
      stopped = true
      clearTimeout(timer)
    },
  }
}
