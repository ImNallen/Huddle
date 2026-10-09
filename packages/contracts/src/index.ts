import { z } from 'zod'

export const WorkspaceId = z.uuid().brand<'WorkspaceId'>()
export const ChannelId = z.uuid().brand<'ChannelId'>()
export const UserId = z.string().min(1).brand<'UserId'>()
export const Cursor = z.string().regex(/^(0|[1-9][0-9]{0,18})$/)
export const Workspace = z.object({
  id: WorkspaceId,
  name: z.string(),
  role: z.enum(['owner', 'member']),
})
export const Channel = z.object({ id: ChannelId, workspaceId: WorkspaceId, name: z.string() })
export const Message = z.object({
  id: z.uuid(),
  channelId: ChannelId,
  authorId: UserId,
  authorName: z.string(),
  retryId: z.uuid(),
  body: z.string(),
  cursor: Cursor,
  createdAt: z.string(),
})
export const WorkspaceEvent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('channel.created'), cursor: Cursor, channel: Channel }),
  z.object({ kind: z.literal('message.created'), cursor: Cursor, message: Message }),
])
export const WatchFrame = z
  .object({
    kind: z.literal('watch'),
    workspaceId: WorkspaceId,
    after: Cursor,
    token: z.string().min(1).max(4096).optional(),
    ticket: z.string().length(43).optional(),
  })
  .strict()
export const EventPage = z.object({ kind: z.literal('events'), events: z.array(WorkspaceEvent) })
export const Snapshot = z.object({
  workspace: Workspace,
  channels: z.array(Channel),
  cursor: Cursor,
})
export const SendMessage = z
  .object({ channelId: ChannelId, retryId: z.uuid(), body: z.string().trim().min(1).max(8000) })
  .strict()
export const CreateChannel = z
  .object({
    workspaceId: WorkspaceId,
    name: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  })
  .strict()
export const CreateWorkspace = z.object({ name: z.string().trim().min(1).max(60) }).strict()
export const InvitationCode = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
export const Session = z.object({
  user: z.object({ id: UserId, name: z.string(), email: z.email() }),
})
export const ServerInfo = z.object({
  name: z.literal('Huddle'),
  websocketUrl: z.url(),
  oidc: z.boolean(),
})
export const DeviceCode = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  verification_uri_complete: z.string().optional(),
  expires_in: z.number(),
  interval: z.number(),
})
export const DeviceToken = z.object({ access_token: z.string() })
export type Workspace = z.infer<typeof Workspace>
export type Channel = z.infer<typeof Channel>
export type Message = z.infer<typeof Message>
export type WorkspaceEvent = z.infer<typeof WorkspaceEvent>
export type Snapshot = z.infer<typeof Snapshot>
export type Session = z.infer<typeof Session>
export type WorkspaceId = z.infer<typeof WorkspaceId>
export type ChannelId = z.infer<typeof ChannelId>
export type UserId = z.infer<typeof UserId>

export function serverOrigin(input: string): string {
  const url = new URL(input)
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('Use a server origin without a path or credentials.')
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    throw new Error('Use HTTPS for a remote server. HTTP is allowed only on localhost.')
  return url.origin
}
