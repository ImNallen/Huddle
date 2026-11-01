import { z } from 'zod'
import { Password, Username } from './invite'

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
export const Channel = z.object({ id: ChannelId, roomId: RoomId, name: z.string() })
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
export const ServerEvent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('room.created'), cursor: Cursor, room: Room }),
  z.object({ kind: z.literal('channel.created'), cursor: Cursor, channel: Channel }),
  z.object({ kind: z.literal('message.created'), cursor: Cursor, message: Message }),
])
export const WatchFrame = z
  .object({
    kind: z.literal('watch'),
    after: Cursor,
    token: z.string().min(1).max(4096).optional(),
    ticket: z.string().length(43).optional(),
  })
  .strict()
export const EventPage = z.object({ kind: z.literal('events'), events: z.array(ServerEvent) })
export const Unread = z.object({ channelId: ChannelId, count: z.number().int().positive() })
export const Snapshot = z.object({
  server: Server,
  rooms: z.array(Room),
  channels: z.array(Channel),
  unread: z.array(Unread),
  cursor: Cursor,
})
export const HomeItem = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('mention'), message: Message }),
  z.object({
    kind: z.literal('channel'),
    channelId: ChannelId,
    count: z.number().int().positive(),
    latest: Message,
  }),
])
export const Home = z.object({ items: z.array(HomeItem) })
export const MarkRead = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('channel'), channelId: ChannelId, cursor: Cursor }).strict(),
  z.object({ kind: z.literal('all'), cursor: Cursor }).strict(),
])
export const SendMessage = z
  .object({ channelId: ChannelId, retryId: z.uuid(), body: z.string().trim().min(1).max(8000) })
  .strict()
export const CreateRoom = z.object({ name: z.string().trim().min(1).max(40) }).strict()
export const CreateChannel = z
  .object({
    roomId: RoomId,
    name: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
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
export const Session = z.object({ user: PublicUser })
export const ServerInfo = z.object({
  name: z.string(),
  setup: z.enum(['required', 'complete']),
  websocketUrl: z.url(),
})
export type Server = z.infer<typeof Server>
export type Member = z.infer<typeof Member>
export type MemberRole = z.infer<typeof MemberRole>
export type Room = z.infer<typeof Room>
export type Channel = z.infer<typeof Channel>
export type Unread = z.infer<typeof Unread>
export type HomeItem = z.infer<typeof HomeItem>
export type Home = z.infer<typeof Home>
export type MarkRead = z.infer<typeof MarkRead>
export type Message = z.infer<typeof Message>
export type ServerEvent = z.infer<typeof ServerEvent>
export type Snapshot = z.infer<typeof Snapshot>
export type Session = z.infer<typeof Session>
export type RoomId = z.infer<typeof RoomId>
export type ChannelId = z.infer<typeof ChannelId>
export type UserId = z.infer<typeof UserId>

export function serverInitials(name: string) {
  return name
    .split(/\s+/)
    .filter((word) => /^[\p{L}\p{N}]/u.test(word))
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase()
}
export function serverOrigin(input: string): string {
  const url = new URL(input)
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('Use a server origin without a path or credentials.')
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    throw new Error('Use HTTPS for a remote server. HTTP is allowed only on localhost.')
  return url.origin
}

export const Profile = z.object({ name: z.string().trim().min(1).max(80), avatar: Avatar }).strict()
export const AccessStage = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('setup') }),
  z.object({ kind: z.literal('signin') }),
  z.object({ kind: z.literal('ready'), user: PublicUser }),
])
export const AccessCommand = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('account.setup'),
      code: SetupCode,
      serverName: ServerName,
      username: Username,
      password: Password,
    })
    .strict(),
  z
    .object({
      kind: z.literal('account.join'),
      code: z.string().regex(/^[A-Za-z0-9_-]{20,128}$/),
      username: Username,
      password: Password,
    })
    .strict(),
  z
    .object({
      kind: z.literal('account.signin'),
      username: Username,
      password: Password,
    })
    .strict(),
  z.object({ kind: z.literal('profile.save'), profile: Profile }).strict(),
  z.object({ kind: z.literal('session.revoke'), id: z.string().min(1).max(512) }).strict(),
  z.object({ kind: z.literal('sessions.revoke-others') }).strict(),
  z.object({ kind: z.literal('password.change'), current: Password, next: Password }).strict(),
  z.object({ kind: z.literal('signout') }).strict(),
])
export const AccessView = z.object({ stage: AccessStage, bearerToken: z.string().optional() })
export const AccessError = z.object({
  error: z.enum(['invalid', 'expired', 'rate_limited', 'unavailable', 'reauth_required']),
  retryAt: z.iso.datetime().optional(),
})
export const AccountSecurity = z.object({
  user: PublicUser,
  sessions: z.array(
    z.object({
      id: z.string(),
      current: z.boolean(),
      createdAt: z.iso.datetime(),
      expiresAt: z.iso.datetime(),
      userAgent: z.string().nullable(),
    }),
  ),
})
export const PhotoUpload = z.object({ uploadId: z.uuid() })
export type Avatar = z.infer<typeof Avatar>
export type Profile = z.infer<typeof Profile>
export type PublicUser = z.infer<typeof PublicUser>
export type AccessStage = z.infer<typeof AccessStage>
export type AccessCommand = z.infer<typeof AccessCommand>
export type AccessView = z.infer<typeof AccessView>
export type AccessError = z.infer<typeof AccessError>
export type AccountSecurity = z.infer<typeof AccountSecurity>
export {
  Username,
  Password,
  FriendInvites,
  formatInvite,
  parseInvite,
  inviteOrigin,
} from './invite'
export type { Invite as FriendInvite } from './invite'
