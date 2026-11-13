import { z } from 'zod'
import {
  Admission,
  ChannelId,
  ConversationId,
  GifRef,
  GroupId,
  UserId,
  sendFields,
} from '@huddle/contracts'
import type { Pending } from './chat'

const Fields = {
  retryId: z.uuid(),
  kind: z.enum(['sending', 'failed']),
  error: z.string().optional(),
}
const Scoped = {
  ...Fields,
  thread: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('channel'), id: ChannelId }),
    z.object({ kind: z.literal('direct'), id: ConversationId }),
    z.object({ kind: z.literal('group'), id: GroupId, admission: Admission }),
  ]),
  peerId: UserId.optional(),
}
const Entry = z.union([
  z
    .object({ ...Scoped, body: z.string() })
    .transform(({ body, ...entry }) => ({ ...entry, content: { kind: 'text' as const, body } })),
  z
    .object({ ...Scoped, gif: GifRef })
    .transform(({ gif, ...entry }) => ({ ...entry, content: { kind: 'gif' as const, gif } })),
  z
    .object({ ...Fields, channelId: ChannelId, body: z.string() })
    .transform(({ channelId, body, ...entry }) => ({
      ...entry,
      thread: { kind: 'channel' as const, id: channelId },
      content: { kind: 'text' as const, body },
    })),
])

export function readOutbox(key: string): Pending[] {
  let stored: unknown
  try {
    stored = JSON.parse(localStorage.getItem(key) ?? '[]')
  } catch {
    return []
  }
  if (!Array.isArray(stored)) return []
  return stored.flatMap((value): Pending[] => {
    const entry = Entry.safeParse(value)
    if (!entry.success) return []
    return [
      {
        ...entry.data,
        kind: 'failed',
        error: 'Sending was interrupted. Retry with the same message ID.',
      },
    ]
  })
}

export function writeOutbox(key: string, items: readonly Pending[]): boolean {
  try {
    localStorage.setItem(
      key,
      JSON.stringify(items.map(({ content, ...entry }) => ({ ...entry, ...sendFields(content) }))),
    )
    return true
  } catch {
    return false
  }
}
