import { z } from 'zod'
import {
  ChannelId,
  CreateChannel,
  CreateWorkspace,
  Cursor,
  InvitationCode,
  SendMessage,
  UserId,
  WorkspaceId,
} from '@huddle/contracts'
import { auth } from './auth'
import { config, origins } from './config'
import * as domain from './domain'
import { db } from './db'

export async function applicationRequest(request: Request): Promise<Response> {
  const origin = request.headers.get('origin')
  if (origin && !origins.has(origin))
    return Response.json({ message: 'Origin is not allowed.' }, { status: 403 })
  const headers = new Headers({
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Expose-Headers': 'set-auth-token',
  })
  if (origin) headers.set('Access-Control-Allow-Origin', origin)
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
  try {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/auth/')) {
      const response = await auth.handler(request)
      for (const [key, value] of headers) response.headers.set(key, value)
      return response
    }
    if (url.pathname === '/api/info')
      return Response.json(
        {
          name: 'Huddle',
          websocketUrl: config.WS_PUBLIC_URL,
          oidc: Boolean(config.OIDC_DISCOVERY_URL),
        },
        { headers },
      )
    if (url.pathname === '/api/health') {
      await db.query('SELECT 1')
      return Response.json({ status: 'ok' }, { headers })
    }
    const session = await auth.api.getSession({ headers: request.headers })
    if (!session) throw new domain.DomainError(401, 'Sign in to continue.')
    const userId = UserId.parse(session.user.id)
    if (request.method === 'POST' && !origin && !request.headers.has('authorization'))
      throw new domain.DomainError(403, 'An origin is required for cookie-authenticated changes.')
    const path = url.pathname
    let result: unknown
    if (request.method === 'GET') {
      if (path === '/api/workspaces') result = await domain.listWorkspaces(userId)
      else if (path === '/api/snapshot')
        result = await domain.snapshot(
          userId,
          WorkspaceId.parse(url.searchParams.get('workspaceId')),
        )
      else if (path === '/api/messages')
        result = await domain.history(
          userId,
          ChannelId.parse(url.searchParams.get('channelId')),
          Cursor.optional().parse(url.searchParams.get('before') ?? undefined),
        )
      else throw new domain.DomainError(404, 'Endpoint not found.')
    } else if (request.method === 'POST') {
      const raw = await request.text()
      if (raw.length > 16000) throw new domain.DomainError(413, 'Request is too large.')
      const body: unknown = JSON.parse(raw)
      if (path === '/api/workspaces')
        result = await domain.createWorkspace(userId, CreateWorkspace.parse(body).name)
      else if (path === '/api/watch-ticket')
        result = await domain.createWatchTicket(session.session.id)
      else if (path === '/api/channels')
        result = await domain.createChannel(userId, CreateChannel.parse(body))
      else if (path === '/api/messages')
        result = await domain.sendMessage(
          { id: userId, name: session.user.name },
          SendMessage.parse(body),
        )
      else if (path === '/api/invitations')
        result = await domain.createInvitation(
          userId,
          z.object({ workspaceId: WorkspaceId }).strict().parse(body).workspaceId,
        )
      else if (path === '/api/invitations/redeem')
        result = await domain.redeemInvitation(
          userId,
          z.object({ code: InvitationCode }).strict().parse(body).code,
        )
      else throw new domain.DomainError(404, 'Endpoint not found.')
    } else throw new domain.DomainError(405, 'Method not allowed.')
    return Response.json(result, { headers })
  } catch (error) {
    if (error instanceof domain.DomainError)
      return Response.json({ message: error.message }, { status: error.status, headers })
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return Response.json({ message: 'Check the submitted values.' }, { status: 400, headers })
    console.error({ event: 'http.failed', error })
    return Response.json(
      { message: 'The server could not complete the request.' },
      { status: 500, headers },
    )
  }
}
