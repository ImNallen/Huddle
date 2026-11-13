import {
  readContent,
  type ChannelId,
  type ConversationId,
  type DirectMessage,
  type GroupId,
  type Admission,
  type GroupMessage,
  type Message,
  type MessageContent,
  type UserId,
  type GroupConversation,
} from '@huddle/contracts'
export type Thread =
  | { kind: 'channel'; id: ChannelId }
  | { kind: 'direct'; id: ConversationId }
  | { kind: 'group'; id: GroupId; admission: Admission }
export const threadKey = (thread: Thread) =>
  `${thread.kind}:${thread.id}${thread.kind === 'group' ? `:${thread.admission}` : ''}`
export type ThreadMessage = Omit<Message, 'channelId' | 'body' | 'gif'> & {
  thread: Thread
  content: MessageContent
}
export type Queued = { retryId: string; thread: Thread; peerId?: UserId; content: MessageContent }
export type Pending = Queued & ({ kind: 'sending' } | { kind: 'failed'; error: string })
export type GroupThread = Extract<Thread, { kind: 'group' }>
export type GroupRow = Omit<GroupConversation, 'latest'> & {
  thread: GroupThread
  latest: ThreadMessage | null
}
type ScopeIds = Partial<Record<'channelId' | 'conversationId' | 'groupId', unknown>>
export function threadMessage(
  wire: Message | DirectMessage | GroupMessage,
  thread: Thread,
): ThreadMessage {
  const { body, gif, ...rest } = wire
  const scoped: Omit<Message, 'channelId' | 'body' | 'gif'> & ScopeIds = rest
  const { channelId: _channel, conversationId: _direct, groupId: _group, ...message } = scoped
  return { ...message, thread, content: readContent({ body, gif }) }
}

export function newerMessage<
  T extends {
    id: string
    revision: string
    reactionRevision: string
    reactions: Message['reactions']
  },
>(current: T | undefined | null, incoming: T): T {
  if (current?.id !== incoming.id) return incoming
  const body = BigInt(current.revision) >= BigInt(incoming.revision) ? current : incoming
  const reaction =
    BigInt(current.reactionRevision) >= BigInt(incoming.reactionRevision) ? current : incoming
  return { ...body, reactions: reaction.reactions, reactionRevision: reaction.reactionRevision }
}
export function latestMessage<
  T extends {
    id: string
    revision: string
    reactionRevision: string
    reactions: Message['reactions']
    cursor: string
  },
>(current: T | null, incoming: T | null): T | null {
  if (!incoming) return current
  if (!current) return incoming
  if (current.id === incoming.id) return newerMessage(current, incoming)
  return BigInt(current.cursor) > BigInt(incoming.cursor) ? current : incoming
}
