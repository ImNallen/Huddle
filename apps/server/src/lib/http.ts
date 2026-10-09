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
import { boundedBody } from './request-body'
import { accessRequest, requireAccess } from './access'
import { accountRequest } from './access-account'
import { deviceRequest } from './access-device'
import { passkeyRequest } from './access-passkey'
import { AccessFailure } from './access-store'
import { companyRequest } from './auth-provider'

export async function applicationRequest(request: Request, trustedIp?: string): Promise<Response> {
  const origin = request.headers.get('origin')
  if (origin && !origins.has(origin))
    return Response.json({ message: 'Origin is not allowed.' }, { status: 403 })
  const headers = new Headers({
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, X-Huddle-Client, X-Huddle-Continuation',
    'Access-Control-Allow-Credentials': 'true',
  })
  if (origin) headers.set('Access-Control-Allow-Origin', origin)
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
  try {
    const url = new URL(request.url)
    const path = url.pathname
    if (request.method === 'POST')
      request = new Request(request, {
        body: await boundedBody(
          request,
          path === '/api/account/photo' ? 5 * 1024 * 1024 + 8192 : 65536,
        ),
      })
    if (
      request.method === 'POST' &&
      !origin &&
      !request.headers.has('authorization') &&
      request.headers.get('x-huddle-client') !== 'native'
    )
      throw new AccessFailure('invalid')
    let accessResponse: Response | undefined
    if (path === '/api/access') accessResponse = await accessRequest(request, trustedIp)
    else if (path.startsWith('/api/access/passkey/')) accessResponse = await passkeyRequest(request)
    else if (path === '/api/account' || path.startsWith('/api/account/photo'))
      accessResponse = await accountRequest(request)
    else if (path === '/api/auth/device' || path.startsWith('/api/auth/device/'))
      accessResponse = await deviceRequest(request, trustedIp)
    else if (path === '/api/auth/get-session') {
      try {
        const actor = await requireAccess(request.headers)
        accessResponse = Response.json({ user: actor.user })
      } catch (error) {
        if (!(error instanceof AccessFailure)) throw error
        accessResponse = Response.json(null)
      }
    } else if (path.startsWith('/api/auth/')) {
      if (
        path === '/api/auth/sign-out' ||
        (config.OIDC_DISCOVERY_URL &&
          [
            '/api/auth/sign-in/oauth2',
            '/api/auth/oauth2/callback/company',
            '/api/auth/callback/company',
          ].includes(path))
      )
        accessResponse =
          path === '/api/auth/sign-out'
            ? await auth.handler(request)
            : await companyRequest(request)
      else throw new AccessFailure('invalid')
    }
    if (accessResponse) {
      accessResponse.headers.set('Cache-Control', 'no-store')
      accessResponse.headers.delete('set-auth-token')
      for (const [key, value] of headers) accessResponse.headers.set(key, value)
      return accessResponse
    }
    if (url.pathname === '/api/info')
      return Response.json(
        {
          name: config.EMAIL.kind === 'smtp' ? config.EMAIL.serverName : 'Huddle',
          policy: config.AUTH_POLICY,
          emailAvailable: config.AUTH_POLICY === 'mixed' && config.EMAIL.kind !== 'disabled',
          websocketUrl: config.WS_PUBLIC_URL,
          oidc: Boolean(config.OIDC_DISCOVERY_URL),
        },
        { headers },
      )
    if (url.pathname === '/api/health') {
      await db.query('SELECT 1')
      return Response.json({ status: 'ok' }, { headers })
    }
    const session = await requireAccess(request.headers)
    const userId = UserId.parse(session.user.id)
    if (request.method === 'POST' && !origin && !request.headers.has('authorization'))
      throw new domain.DomainError(403, 'An origin is required for cookie-authenticated changes.')
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
          { id: userId, name: session.user.name, avatar: session.user.avatar },
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
    if (error instanceof AccessFailure)
      return Response.json(
        { error: error.code, retryAt: error.retryAt },
        {
          status: {
            invalid: 400,
            expired: 410,
            rate_limited: 429,
            unavailable: 503,
            reauth_required: 401,
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
