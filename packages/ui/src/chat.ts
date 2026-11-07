import type {
  ChannelId,
  ConversationId,
  GroupId,
  Admission,
  Message,
  UserId,
  GroupConversation,
} from '@huddle/contracts'
export type Thread =
  | { kind: 'channel'; id: ChannelId }
  | { kind: 'direct'; id: ConversationId }
  | { kind: 'group'; id: GroupId; admission: Admission }
export const threadKey = (thread: Thread) =>
  `${thread.kind}:${thread.id}${thread.kind === 'group' ? `:${thread.admission}` : ''}`
export type ThreadMessage = Omit<Message, 'channelId'> & { thread: Thread }
export type Queued = { retryId: string; thread: Thread; peerId?: UserId; body: string }
export type Pending = Queued & ({ kind: 'sending' } | { kind: 'failed'; error: string })
export type GroupThread = Extract<Thread, { kind: 'group' }>
export type GroupRow = GroupConversation & { thread: GroupThread }
