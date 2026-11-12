import { z } from 'zod'
import {
  EditMessage,
  EditDirectMessage,
  EditGroupMessage,
  GroupAccess,
  CreateGroup,
  AddGroupPeople,
  SendGroupMessage,
  MarkGroupRead,
  ChannelId,
  ConversationId,
  CreateChannel,
  CreateRoom,
  Cursor,
  DeleteChannel,
  DeleteRoom,
  RenameChannel,
  RenameRoom,
  RenameServer,
  RemoveMember,
  UnblockMember,
  JoinVoice,
  MarkDirectRead,
  MarkRead,
  OpenDirect,
  SendDirectMessage,
  SendMessage,
} from '@huddle/contracts'
import { config } from './config'
import * as domain from './domain'
import { db } from './db'
import { boundedBody } from './request-body'
import { accessRequest } from './access'
import { accountRequest } from './access-account'
import { AccessFailure } from './access-store'
import { serverName, setupRequired } from './admission'
import { serverInvite } from './accounts'
import { contextAllowed, requireAccess } from './identity'

export async function applicationRequest(request: Request): Promise<Response> {
  const origin = request.headers.get('origin')
  if (!contextAllowed(request.headers, request.method === 'GET' ? 'read' : 'write'))
    return Response.json({ message: 'This page may not use Huddle.' }, { status: 403 })
  const headers = new Headers({
    'Cache-Control': 'no-store',
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Huddle-User',
  })
  if (origin) headers.set('Access-Control-Allow-Origin', origin)
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
  try {
    const url = new URL(request.url)
    const path = url.pathname
    if (request.method === 'POST')
      request = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        signal: request.signal,
        body: await boundedBody(
          request,
          path === '/api/account/photo' ? 5 * 1024 * 1024 + 8192 : 65536,
        ),
      })
    const withHeaders = (response: Response) => {
      for (const [key, value] of headers) response.headers.set(key, value)
      return response
    }
    if (path === '/api/access') return withHeaders(await accessRequest(request))
    if (url.pathname === '/api/info')
      return Response.json(
        {
          name: await serverName(),
          setup: (await setupRequired()) ? 'required' : 'complete',
          serverUrl: config.SERVER_URL,
          websocketUrl: config.WS_PUBLIC_URL,
          voice: config.voice !== null,
        },
        { headers },
      )
    if (url.pathname === '/api/health') {
      await db.query('SELECT 1')
      return Response.json({ status: 'ok' }, { headers })
    }
    const member = await requireAccess(request.headers)
    const { user } = member
    const userId = user.id
    if (request.method === 'POST' && request.headers.get('x-huddle-user') !== userId)
      throw new AccessFailure('no_access')
    if (path === '/api/account' || path.startsWith('/api/account/photo'))
      return withHeaders(await accountRequest(request, member))
    let result: unknown
    if (request.method === 'GET') {
      if (path === '/api/snapshot') result = await domain.snapshot(userId)
      else if (path === '/api/members') result = await domain.members(userId)
      else if (path === '/api/invite') result = await serverInvite(userId)
      else if (path === '/api/blocked') result = await domain.blocked(userId)
      else if (path === '/api/messages')
        result = await domain.history(
          userId,
          ChannelId.parse(url.searchParams.get('channelId')),
          Cursor.optional().parse(url.searchParams.get('before') ?? undefined),
        )
      else if (path === '/api/group/messages')
        result = await domain.groupHistory(
          userId,
          GroupAccess.parse({
            groupId: url.searchParams.get('groupId'),
            admission: url.searchParams.get('admission'),
          }),
          Cursor.optional().parse(url.searchParams.get('before') ?? undefined),
        )
      else if (path === '/api/direct/messages')
        result = await domain.directHistory(
          userId,
          ConversationId.parse(url.searchParams.get('conversationId')),
          Cursor.optional().parse(url.searchParams.get('before') ?? undefined),
        )
      else throw new domain.DomainError(404, 'Endpoint not found.')
    } else if (request.method === 'POST') {
      const raw = await request.text()
      if (raw.length > 16000) throw new domain.DomainError(413, 'Request is too large.')
      const body: unknown = JSON.parse(raw)
      if (path === '/api/rooms') result = await domain.createRoom(userId, CreateRoom.parse(body))
      else if (path === '/api/channels')
        result = await domain.createChannel(userId, CreateChannel.parse(body))
      else if (path === '/api/server/rename') {
        await domain.renameServer(userId, RenameServer.parse(body))
        result = {}
      } else if (path === '/api/rooms/rename') {
        await domain.renameRoom(userId, RenameRoom.parse(body))
        result = {}
      } else if (path === '/api/rooms/delete') {
        await domain.deleteRoom(userId, DeleteRoom.parse(body))
        result = {}
      } else if (path === '/api/channels/rename') {
        await domain.renameChannel(userId, RenameChannel.parse(body))
        result = {}
      } else if (path === '/api/channels/delete') {
        await domain.deleteChannel(userId, DeleteChannel.parse(body))
        result = {}
      } else if (path === '/api/members/remove') {
        await domain.removeMember(userId, RemoveMember.parse(body))
        result = {}
      } else if (path === '/api/members/unblock') {
        await domain.unblockMember(userId, UnblockMember.parse(body))
        result = {}
      } else if (path === '/api/read') {
        await domain.markRead(userId, MarkRead.parse(body))
        result = {}
      } else if (path === '/api/messages')
        result = await domain.sendMessage(user, SendMessage.parse(body))
      else if (path === '/api/messages/edit')
        result = await domain.editMessage(userId, { kind: 'channel', ...EditMessage.parse(body) })
      else if (path === '/api/direct/messages/edit')
        result = await domain.editMessage(userId, {
          kind: 'direct',
          ...EditDirectMessage.parse(body),
        })
      else if (path === '/api/group/messages/edit')
        result = await domain.editMessage(userId, {
          kind: 'group',
          ...EditGroupMessage.parse(body),
        })
      else if (path === '/api/groups')
        result = await domain.createGroup(userId, CreateGroup.parse(body))
      else if (path === '/api/group/people')
        result = await domain.addGroupPeople(userId, AddGroupPeople.parse(body))
      else if (path === '/api/group/leave')
        result = await domain.leaveGroup(userId, GroupAccess.parse(body))
      else if (path === '/api/group/messages')
        result = await domain.sendGroupMessage(user, SendGroupMessage.parse(body))
      else if (path === '/api/group/read') {
        await domain.markGroupRead(userId, MarkGroupRead.parse(body))
        result = {}
      } else if (path === '/api/direct/conversations')
        result = await domain.openDirect(userId, OpenDirect.parse(body))
      else if (path === '/api/direct/messages')
        result = await domain.sendDirectMessage(user, SendDirectMessage.parse(body))
      else if (path === '/api/direct/read') {
        await domain.markDirectRead(userId, MarkDirectRead.parse(body))
        result = {}
      } else if (path === '/api/voice/token')
        result = await domain.voiceGrant(user, JoinVoice.parse(body))
      else throw new domain.DomainError(404, 'Endpoint not found.')
    } else throw new domain.DomainError(405, 'Method not allowed.')
    return Response.json(result, { headers })
  } catch (error) {
    if (error instanceof AccessFailure)
      return Response.json(
        { error: error.code, retryAt: error.retryAt },
        {
          status: {
            invalid: 400,
            expired: 410,
            rate_limited: 429,
            unavailable: 503,
            no_access: 401,
          }[error.code],
          headers,
        },
      )
    if (error instanceof domain.DomainError)
      return Response.json({ message: error.message }, { status: error.status, headers })
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return Response.json(
        new URL(request.url).pathname.startsWith('/api/access') ||
          new URL(request.url).pathname.startsWith('/api/account')
          ? { error: 'invalid' }
          : { message: 'Check the submitted values.' },
        { status: 400, headers },
      )
    console.error({ event: 'http.failed', error })
    return Response.json(
      { message: 'The server could not complete the request.' },
      { status: 500, headers },
    )
  }
}
