import { z } from 'zod'
import { JoinCode } from './invite'

export const MascotShape = z.enum(['circle', 'square', 'bean', 'hexagon', 'triangle', 'flower'])
export const MascotColor = z.enum([
  'indigo',
  'sky',
  'teal',
  'lime',
  'amber',
  'orange',
  'rose',
  'violet',
])
export const Avatar = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('mascot'), shape: MascotShape, color: MascotColor }).strict(),
  z.object({ kind: z.literal('photo'), uploadId: z.uuid() }).strict(),
])

export const RoomId = z.uuid().brand<'RoomId'>()
export const ChannelId = z.uuid().brand<'ChannelId'>()
export const ConversationId = z.uuid().brand<'ConversationId'>()
export const UserId = z.string().min(1).brand<'UserId'>()
export const Cursor = z.string().regex(/^(0|[1-9][0-9]{0,18})$/)
export const MemberRole = z.enum(['admin', 'member'])
export const Server = z.object({
  name: z.string(),
  role: MemberRole,
  memberCount: z.number().int().nonnegative(),
  channelCount: z.number().int().nonnegative(),
})
export const Room = z.object({ id: RoomId, name: z.string() })
export const ChannelKind = z.enum(['text', 'voice'])
export const Channel = z.object({
  id: ChannelId,
  roomId: RoomId,
  name: z.string(),
  kind: ChannelKind,
})
export const Message = z.object({
  id: z.uuid(),
  channelId: ChannelId,
  authorId: UserId,
  authorName: z.string(),
  authorAvatar: Avatar.nullish(),
  retryId: z.uuid(),
  body: z.string(),
  cursor: Cursor,
  createdAt: z.string(),
})
export const DirectMessage = Message.omit({ channelId: true }).extend({
  conversationId: ConversationId,
})
export const DirectConversation = z.object({
  id: ConversationId,
  peerId: UserId,
  latest: DirectMessage.nullable(),
  unread: z.number().int().nonnegative(),
})
export const ServerEvent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('room.created'), cursor: Cursor, room: Room }),
  z.object({ kind: z.literal('channel.created'), cursor: Cursor, channel: Channel }),
  z.object({
    kind: z.literal('message.created'),
    cursor: Cursor,
    message: Message,
    mentions: z.array(UserId).default([]),
  }),
  z.object({
    kind: z.literal('direct.message.created'),
    cursor: Cursor,
    message: DirectMessage,
    participants: z.tuple([UserId, UserId]),
  }),
])
export const WatchFrame = z.object({ kind: z.literal('watch'), after: Cursor }).strict()
export const EventPage = z.object({ kind: z.literal('events'), events: z.array(ServerEvent) })
export const Unread = z.object({
  channelId: ChannelId,
  count: z.number().int().positive(),
  mentions: z.number().int().nonnegative(),
})
export const Snapshot = z.object({
  server: Server,
  rooms: z.array(Room),
  channels: z.array(Channel),
  unread: z.array(Unread),
  directs: z.array(DirectConversation),
  cursor: Cursor,
})
export const MarkRead = z.object({ channelId: ChannelId, cursor: Cursor }).strict()
const MessageBody = z.string().trim().min(1).max(8000)
export const SendMessage = z
  .object({ channelId: ChannelId, retryId: z.uuid(), body: MessageBody })
  .strict()
export const OpenDirect = z.object({ userId: UserId }).strict()
export const SendDirectMessage = z
  .object({ conversationId: ConversationId, retryId: z.uuid(), body: MessageBody })
  .strict()
export const MarkDirectRead = z.object({ conversationId: ConversationId, cursor: Cursor }).strict()
export const CreateRoom = z.object({ name: z.string().trim().min(1).max(40) }).strict()
export const CreateChannel = z
  .object({
    roomId: RoomId,
    name: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
    kind: ChannelKind,
  })
  .strict()
export const Member = z.object({
  id: UserId,
  name: z.string(),
  avatar: Avatar,
  role: MemberRole,
  joinedAt: z.iso.datetime(),
})
export const Members = z.object({ members: z.array(Member) })
export const ServerName = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[^\x00-\x1f\x7f]+$/)
export const SetupCode = z.string().trim().min(1).max(64)
export const PublicUser = z.object({ id: UserId, name: z.string(), avatar: Avatar })
export const Me = z.object({ user: PublicUser })
export const ServerInfo = z.object({
  name: z.string(),
  setup: z.enum(['required', 'complete']),
  serverUrl: z.url(),
  websocketUrl: z.url(),
})
export type Server = z.infer<typeof Server>
export type Member = z.infer<typeof Member>
export type MemberRole = z.infer<typeof MemberRole>
export type Room = z.infer<typeof Room>
export type ChannelKind = z.infer<typeof ChannelKind>
export type Channel = z.infer<typeof Channel>
export type Unread = z.infer<typeof Unread>
export type MarkRead = z.infer<typeof MarkRead>
export type Message = z.infer<typeof Message>
export type DirectMessage = z.infer<typeof DirectMessage>
export type DirectConversation = z.infer<typeof DirectConversation>
export type ServerEvent = z.infer<typeof ServerEvent>
export type Snapshot = z.infer<typeof Snapshot>
export type Me = z.infer<typeof Me>
export type RoomId = z.infer<typeof RoomId>
export type ChannelId = z.infer<typeof ChannelId>
export type ConversationId = z.infer<typeof ConversationId>
export type UserId = z.infer<typeof UserId>

export function defaultMascot(userId: string): Avatar {
  let hash = 0
  for (const char of userId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  const color = MascotColor.options[hash % MascotColor.options.length] ?? 'indigo'
  return { kind: 'mascot', shape: 'circle', color }
}
export function serverInitials(name: string) {
  return name
    .split(/\s+/)
    .filter((word) => /^[\p{L}\p{N}]/u.test(word))
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase()
}
/** Compared exactly as Serve delivers it, after RFC 2047 decoding. Never case-folded. Commas are refused
 *  because Node joins a repeated header with ', '. */
export const TailscaleLogin = z
  .string()
  .min(3)
  .max(320)
  .regex(/^[^\s,\x00-\x1f\x7f]+@[^\s,@\x00-\x1f\x7f]+$/)
  .brand<'TailscaleLogin'>()
const DisplayName = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[^\x00-\x1f\x7f]+$/)
export const Profile = z.object({ name: DisplayName, avatar: Avatar }).strict()
export const NoIdentityReason = z.enum(['no-user', 'funnel', 'direct'])
export const AccessStage = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('no-identity'), reason: NoIdentityReason }),
  z.object({ kind: z.literal('setup'), login: TailscaleLogin, suggestedName: z.string() }),
  z.object({ kind: z.literal('join'), login: TailscaleLogin, suggestedName: z.string() }),
  z.object({ kind: z.literal('ready'), login: TailscaleLogin, user: PublicUser }),
])
export const AccessCommand = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('account.setup'),
      code: SetupCode,
      serverName: ServerName,
      name: DisplayName,
    })
    .strict(),
  z.object({ kind: z.literal('account.join'), code: JoinCode, name: DisplayName }).strict(),
  z.object({ kind: z.literal('profile.save'), profile: Profile }).strict(),
])
export const AccessError = z.object({
  error: z.enum(['invalid', 'expired', 'rate_limited', 'unavailable', 'no_access']),
  retryAt: z.iso.datetime().optional(),
})
export const Account = z.object({ user: PublicUser, login: TailscaleLogin })
export const ServerInvite = z.object({ invite: z.string().min(1).max(2048) })
export const PhotoUpload = z.object({ uploadId: z.uuid() })
export type TailscaleLogin = z.infer<typeof TailscaleLogin>
export type NoIdentityReason = z.infer<typeof NoIdentityReason>
export type Avatar = z.infer<typeof Avatar>
export type Profile = z.infer<typeof Profile>
export type PublicUser = z.infer<typeof PublicUser>
export type AccessStage = z.infer<typeof AccessStage>
export type AccessCommand = z.infer<typeof AccessCommand>
export type AccessError = z.infer<typeof AccessError>
export { JoinCode, formatInvite, parseInvite, serverOrigin } from './invite'
export type { Invite } from './invite'
