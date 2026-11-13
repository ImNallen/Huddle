import { z } from 'zod'
import { EmojiSymbol } from '@huddle/contracts'

const Avatar = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('mascot'),
      shape: z.enum(['circle', 'square', 'bean', 'hexagon', 'triangle', 'flower']),
      color: z.enum(['indigo', 'sky', 'teal', 'lime', 'amber', 'orange', 'rose', 'violet']),
    })
    .strict(),
  z.object({ kind: z.literal('photo'), uploadId: z.uuid() }).strict(),
])
const UserId = z.string().min(1)
const Cursor = z.string().regex(/^(0|[1-9][0-9]{0,18})$/)
const Room = z.object({ id: z.uuid(), name: z.string() })
const Channel = z.object({
  id: z.uuid(),
  roomId: z.uuid(),
  name: z.string(),
  kind: z.enum(['text', 'voice']),
})
const MessageReaction = z.object({
  emoji: EmojiSymbol,
  people: z.array(z.object({ id: UserId, name: z.string(), avatar: Avatar })),
})
export const LegacyMessage = z.object({
  id: z.uuid(),
  channelId: z.uuid(),
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
export const LegacyDirectMessage = LegacyMessage.omit({ channelId: true }).extend({
  conversationId: z.uuid(),
})
export const LegacyGroupMessage = LegacyMessage.omit({ channelId: true }).extend({
  groupId: z.uuid(),
})
const DirectConversation = z.object({
  id: z.uuid(),
  peerId: UserId,
  latest: LegacyDirectMessage.nullable(),
  unread: z.number().int().nonnegative(),
})
const GroupMetadata = z.object({
  id: z.uuid(),
  name: z.string(),
  members: z.array(z.object({ userId: UserId, admission: Cursor })),
  revision: Cursor,
  latest: LegacyGroupMessage.nullable(),
})
const GroupConversation = GroupMetadata.extend({
  readCursor: Cursor,
  unread: z.number().int().nonnegative(),
})
const ServerEvent = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('message.reactions.changed'),
    cursor: Cursor,
    message: LegacyMessage,
  }),
  z.object({
    kind: z.literal('direct.message.reactions.changed'),
    cursor: Cursor,
    message: LegacyDirectMessage,
    participants: z.tuple([UserId, UserId]),
  }),
  z.object({
    kind: z.literal('group.message.reactions.changed'),
    cursor: Cursor,
    message: LegacyGroupMessage,
  }),
  z.object({ kind: z.literal('message.edited'), cursor: Cursor, message: LegacyMessage }),
  z.object({
    kind: z.literal('direct.message.edited'),
    cursor: Cursor,
    message: LegacyDirectMessage,
    participants: z.tuple([UserId, UserId]),
  }),
  z.object({
    kind: z.literal('group.message.edited'),
    cursor: Cursor,
    message: LegacyGroupMessage,
  }),
  z.object({ kind: z.literal('group.changed'), cursor: Cursor, group: GroupMetadata }),
  z.object({
    kind: z.literal('group.removed'),
    cursor: Cursor,
    groupId: z.uuid(),
    admission: Cursor,
  }),
  z.object({
    kind: z.literal('group.message.created'),
    cursor: Cursor,
    message: LegacyGroupMessage,
  }),
  z.object({ kind: z.literal('room.created'), cursor: Cursor, room: Room }),
  z.object({ kind: z.literal('channel.created'), cursor: Cursor, channel: Channel }),
  z.object({
    kind: z.literal('message.created'),
    cursor: Cursor,
    message: LegacyMessage,
    mentions: z.array(UserId).default([]),
  }),
  z.object({
    kind: z.literal('direct.message.created'),
    cursor: Cursor,
    message: LegacyDirectMessage,
    participants: z.tuple([UserId, UserId]),
  }),
  z.object({ kind: z.literal('server.renamed'), cursor: Cursor, name: z.string() }),
  z.object({ kind: z.literal('room.renamed'), cursor: Cursor, room: Room }),
  z.object({ kind: z.literal('room.deleted'), cursor: Cursor, roomId: z.uuid() }),
  z.object({ kind: z.literal('channel.renamed'), cursor: Cursor, channel: Channel }),
  z.object({
    kind: z.literal('channel.deleted'),
    cursor: Cursor,
    channelId: z.uuid(),
    roomId: z.uuid(),
  }),
  z.object({ kind: z.literal('member.removed'), cursor: Cursor, userId: UserId }),
])
const VoicePresence = z.array(
  z.object({
    channelId: z.uuid(),
    people: z.array(z.object({ id: UserId, name: z.string() })),
  }),
)
export const LegacyEventPage = z.object({
  kind: z.literal('events'),
  events: z.array(ServerEvent),
  voice: VoicePresence.optional(),
})
export const LegacySnapshot = z.object({
  server: z.object({
    name: z.string(),
    role: z.enum(['admin', 'member']),
    memberCount: z.number().int().nonnegative(),
    channelCount: z.number().int().nonnegative(),
  }),
  rooms: z.array(Room),
  channels: z.array(Channel),
  unread: z.array(
    z.object({
      channelId: z.uuid(),
      count: z.number().int().positive(),
      mentions: z.number().int().nonnegative(),
    }),
  ),
  directs: z.array(DirectConversation),
  groups: z.array(GroupConversation),
  cursor: Cursor,
})

const GroupObservation = z.object({ at: Cursor, group: GroupConversation })
const answers: Record<string, { get?: z.ZodType; post?: z.ZodType }> = {
  '/api/snapshot': { get: LegacySnapshot },
  '/api/messages': { get: LegacyMessage.array(), post: LegacyMessage },
  '/api/messages/edit': { post: LegacyMessage },
  '/api/messages/reaction': { post: LegacyMessage },
  '/api/direct/conversations': { post: DirectConversation },
  '/api/direct/messages': { get: LegacyDirectMessage.array(), post: LegacyDirectMessage },
  '/api/direct/messages/edit': { post: LegacyDirectMessage },
  '/api/direct/messages/reaction': { post: LegacyDirectMessage },
  '/api/groups': { post: GroupObservation },
  '/api/group/people': { post: GroupObservation },
  '/api/group/messages': { get: LegacyGroupMessage.array(), post: LegacyGroupMessage },
  '/api/group/messages/edit': { post: LegacyGroupMessage },
  '/api/group/messages/reaction': { post: LegacyGroupMessage },
}
export function legacyAnswer(path: string, post: boolean): z.ZodType | undefined {
  const route = answers[path.split('?')[0] ?? '']
  return post ? route?.post : route?.get
}
