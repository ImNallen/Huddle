import { z } from 'zod'
import { JoinCode } from './invite'
import { emojiCatalog } from './emoji'
export * from './emoji'
export const EmojiSymbol = z
  .string()
  .refine((value) => emojiCatalog.some(([symbol]) => symbol === value), 'Unsupported emoji')

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
export const MessageReaction = z.object({
  emoji: EmojiSymbol,
  people: z.array(z.object({ id: UserId, name: z.string(), avatar: Avatar })),
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
  reactionRevision: Cursor.default('0'),
  reactions: z.array(MessageReaction).default([]),
  revision: Cursor.default('0'),
  editedAt: z.string().nullable().default(null),
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
export const GroupId = z.uuid().brand<'GroupId'>()
export const Admission = Cursor.brand<'Admission'>()
export const GroupAccess = z.object({ groupId: GroupId, admission: Admission }).strict()
export const GroupMessage = Message.omit({ channelId: true }).extend({ groupId: GroupId })
export const GroupMetadata = z.object({
  id: GroupId,
  name: z.string(),
  members: z.array(z.object({ userId: UserId, admission: Admission })),
  revision: Cursor,
  latest: GroupMessage.nullable(),
})
export const GroupConversation = GroupMetadata.extend({
  readCursor: Cursor,
  unread: z.number().int().nonnegative(),
})
export const GroupObservation = z.object({ at: Cursor, group: GroupConversation })
export const GroupRemoval = GroupAccess.extend({ cursor: Cursor })
const GroupName = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[^\x00-\x1f\x7f]+$/)
const GroupPeople = z
  .array(UserId)
  .max(31)
  .refine((ids) => new Set(ids).size === ids.length)
export const CreateGroup = z
  .object({ retryId: z.uuid(), name: GroupName, others: GroupPeople.min(2) })
  .strict()
export const AddGroupPeople = GroupAccess.extend({ userIds: GroupPeople.min(1) }).strict()
export const SendGroupMessage = GroupAccess.extend({
  retryId: z.uuid(),
  body: z.string().trim().min(1).max(8000),
}).strict()
export const MarkGroupRead = GroupAccess.extend({ cursor: Cursor }).strict()
export type GroupId = z.infer<typeof GroupId>
export type Admission = z.infer<typeof Admission>
export type GroupAccess = z.infer<typeof GroupAccess>
export type GroupMessage = z.infer<typeof GroupMessage>
export type GroupMetadata = z.infer<typeof GroupMetadata>
export type GroupConversation = z.infer<typeof GroupConversation>
export type GroupRemoval = z.infer<typeof GroupRemoval>
const EditFields = {
  messageId: z.uuid(),
  expectedRevision: Cursor,
  retryId: z.uuid(),
  body: z.string().trim().min(1).max(8000),
}
export const EditMessage = z.object({ channelId: ChannelId, ...EditFields }).strict()
export const EditDirectMessage = z
  .object({ conversationId: ConversationId, ...EditFields })
  .strict()
export const EditGroupMessage = GroupAccess.extend(EditFields).strict()
export type EditMessage = z.infer<typeof EditMessage>
export type EditDirectMessage = z.infer<typeof EditDirectMessage>
export type EditGroupMessage = z.infer<typeof EditGroupMessage>

const ReactionFields = {
  messageId: z.uuid(),
  emoji: EmojiSymbol,
  present: z.boolean(),
  retryId: z.uuid(),
}
export const SetReaction = z.object({ channelId: ChannelId, ...ReactionFields }).strict()
export const SetDirectReaction = z
  .object({ conversationId: ConversationId, ...ReactionFields })
  .strict()
export const SetGroupReaction = GroupAccess.extend(ReactionFields).strict()
export type ReactionCommand =
  | ({ kind: 'channel' } & z.infer<typeof SetReaction>)
  | ({ kind: 'direct' } & z.infer<typeof SetDirectReaction>)
  | ({ kind: 'group' } & z.infer<typeof SetGroupReaction>)

export const ServerEvent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('message.reactions.changed'), cursor: Cursor, message: Message }),
  z.object({
    kind: z.literal('direct.message.reactions.changed'),
    cursor: Cursor,
    message: DirectMessage,
    participants: z.tuple([UserId, UserId]),
  }),
  z.object({
    kind: z.literal('group.message.reactions.changed'),
    cursor: Cursor,
    message: GroupMessage,
  }),
  z.object({ kind: z.literal('message.edited'), cursor: Cursor, message: Message }),
  z.object({
    kind: z.literal('direct.message.edited'),
    cursor: Cursor,
    message: DirectMessage,
    participants: z.tuple([UserId, UserId]),
  }),
  z.object({ kind: z.literal('group.message.edited'), cursor: Cursor, message: GroupMessage }),
  z.object({ kind: z.literal('group.changed'), cursor: Cursor, group: GroupMetadata }),
  z.object({
    kind: z.literal('group.removed'),
    cursor: Cursor,
    groupId: GroupId,
    admission: Admission,
  }),
  z.object({ kind: z.literal('group.message.created'), cursor: Cursor, message: GroupMessage }),
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
  z.object({ kind: z.literal('server.renamed'), cursor: Cursor, name: z.string() }),
  z.object({ kind: z.literal('room.renamed'), cursor: Cursor, room: Room }),
  z.object({ kind: z.literal('room.deleted'), cursor: Cursor, roomId: RoomId }),
  z.object({ kind: z.literal('channel.renamed'), cursor: Cursor, channel: Channel }),
  z.object({
    kind: z.literal('channel.deleted'),
    cursor: Cursor,
    channelId: ChannelId,
    roomId: RoomId,
  }),
  z.object({ kind: z.literal('member.removed'), cursor: Cursor, userId: UserId }),
])
export const WatchFrame = z.object({ kind: z.literal('watch'), after: Cursor }).strict()
export const VoicePresence = z.array(
  z.object({
    channelId: ChannelId,
    people: z.array(z.object({ id: UserId, name: z.string() })),
  }),
)
export type VoicePresence = z.infer<typeof VoicePresence>
export const EventPage = z.object({
  kind: z.literal('events'),
  events: z.array(ServerEvent),
  voice: VoicePresence.optional(),
})
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
  groups: z.array(GroupConversation),
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
export const RoomName = z.string().trim().min(1).max(40)
export const CreateRoom = z.object({ name: RoomName }).strict()
export const RenameRoom = z.object({ roomId: RoomId, name: RoomName }).strict()
export const TEXT_CHANNEL_NAME_PATTERN = String.raw`[\p{L}\p{N}][\p{L}\p{M}\p{N}\-]*`
const TextChannelName = z
  .string()
  .trim()
  .transform((name) => name.normalize('NFC').toLowerCase())
  .pipe(
    z
      .string()
      .max(40)
      .regex(new RegExp(`^${TEXT_CHANNEL_NAME_PATTERN}$`, 'u')),
  )
const VoiceChannelName = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[^\x00-\x1f\x7f]+$/)
const ChannelNames = {
  text: { kind: z.literal('text'), name: TextChannelName },
  voice: { kind: z.literal('voice'), name: VoiceChannelName },
}
export const CreateChannel = z.discriminatedUnion('kind', [
  z.object({ roomId: RoomId, ...ChannelNames.text }).strict(),
  z.object({ roomId: RoomId, ...ChannelNames.voice }).strict(),
])
export const RenameChannel = z.discriminatedUnion('kind', [
  z.object({ channelId: ChannelId, ...ChannelNames.text }).strict(),
  z.object({ channelId: ChannelId, ...ChannelNames.voice }).strict(),
])
const Confirm = z.string().trim().min(1).max(80)
export const DeleteRoom = z.object({ roomId: RoomId, confirm: Confirm }).strict()
export const DeleteChannel = z.object({ channelId: ChannelId, confirm: Confirm }).strict()
export const Member = z.object({
  id: UserId,
  name: z.string(),
  avatar: Avatar,
  role: MemberRole,
  joinedAt: z.iso.datetime(),
})
export const ServerName = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[^\x00-\x1f\x7f]+$/)
export const RenameServer = z.object({ name: ServerName }).strict()
export const SetupCode = z.string().trim().min(1).max(64)
export const PublicUser = z.object({ id: UserId, name: z.string(), avatar: Avatar })
export const Members = z.object({
  members: z.array(Member),
  former: z.array(PublicUser).default([]),
})
export const RemoveMember = z.object({ userId: UserId }).strict()
export const UnblockMember = z.object({ userId: UserId }).strict()
export const BlockedPerson = PublicUser.extend({ removedAt: z.iso.datetime() })
export const Blocked = z.object({ blocked: z.array(BlockedPerson) })
export const Me = z.object({ user: PublicUser })
export const ServerInfo = z.object({
  name: z.string(),
  setup: z.enum(['required', 'complete']),
  serverUrl: z.url(),
  websocketUrl: z.url(),
  voice: z.boolean().default(false),
})
export const JoinVoice = z.object({ channelId: ChannelId }).strict()
export const VoiceGrant = z.object({ url: z.url(), token: z.string().min(1) })
export type Server = z.infer<typeof Server>
export type Member = z.infer<typeof Member>
export type BlockedPerson = z.infer<typeof BlockedPerson>
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
  z.object({ kind: z.literal('removed'), login: TailscaleLogin }),
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
