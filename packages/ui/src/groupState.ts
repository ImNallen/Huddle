import type {
  Admission,
  GroupConversation,
  GroupId,
  GroupMetadata,
  GroupMessage,
  UserId,
} from '@huddle/contracts'
import {
  newerMessage,
  latestMessage,
  threadKey,
  type Pending,
  type Thread,
  type ThreadMessage,
} from './chat'

export type GroupThread = Extract<Thread, { kind: 'group' }>
type Authority = {
  at: string
  endedThrough: string
  current: { group: GroupConversation; thread: GroupThread; contentFloor: string } | null
}
export type GroupState = {
  authority: ReadonlyMap<GroupId, Authority>
  snapshotFloor: string
  messages: ThreadMessage[]
  pending: Pending[]
  drafts: ReadonlyMap<string, string>
}
export function initialGroups(pending: Pending[]): GroupState {
  return { authority: new Map(), snapshotFloor: '0', messages: [], pending, drafts: new Map() }
}
export function hasGroup(state: GroupState, thread: GroupThread) {
  return state.authority.get(thread.id)?.current?.thread.admission === thread.admission
}
function purge(state: GroupState, id: GroupId): GroupState {
  return {
    ...state,
    messages: state.messages.filter((m) => m.thread.id !== id),
    pending: state.pending.filter((p) => p.thread.id !== id),
    drafts: new Map([...state.drafts].filter(([key]) => !key.startsWith(`group:${id}:`))),
  }
}
export function observeGroup(
  state: GroupState,
  group: GroupMetadata,
  at: string,
  userId: UserId,
  summary?: GroupConversation,
  resetRead = false,
): GroupState {
  const member = group.members.find((m) => m.userId === userId)
  if (!member) return state
  const old = state.authority.get(group.id)
  if (
    BigInt(at) < BigInt(state.snapshotFloor) ||
    BigInt(at) < BigInt(old?.at ?? '0') ||
    BigInt(member.admission) <= BigInt(old?.endedThrough ?? '0')
  )
    return state
  const same = old?.current?.thread.admission === member.admission
  const next = same ? state : purge(state, group.id)
  const previous = same ? old?.current : null
  const observed = !same || resetRead ? summary : undefined
  const value: Authority = {
    at,
    endedThrough: old?.endedThrough ?? '0',
    current: {
      thread: { kind: 'group', id: group.id, admission: member.admission },
      group: {
        ...group,
        latest: latestMessage(previous?.group.latest ?? null, group.latest),
        readCursor: observed?.readCursor ?? previous?.group.readCursor ?? member.admission,
        unread: observed?.unread ?? previous?.group.unread ?? 0,
      },
      contentFloor: observed ? at : (previous?.contentFloor ?? member.admission),
    },
  }
  const observedState = { ...next, authority: new Map(next.authority).set(group.id, value) }
  const latest = value.current?.group.latest
  return latest
    ? {
        ...observedState,
        messages: observedState.messages.map((message) =>
          message.id === latest.id
            ? newerMessage(message, { ...latest, thread: message.thread })
            : message,
        ),
      }
    : observedState
}
export function revokeGroup(state: GroupState, thread: GroupThread, at?: string): GroupState {
  const old = state.authority.get(thread.id)
  const endedThrough =
    BigInt(old?.endedThrough ?? '0') > BigInt(thread.admission)
      ? (old?.endedThrough ?? '0')
      : thread.admission
  const newer = old?.current && BigInt(old.current.thread.admission) > BigInt(thread.admission)
  const next = newer ? state : purge(state, thread.id)
  return {
    ...next,
    authority: new Map(next.authority).set(thread.id, {
      at: BigInt(at ?? '0') > BigInt(old?.at ?? '0') ? (at ?? '0') : (old?.at ?? '0'),
      endedThrough,
      current: newer ? old.current : null,
    }),
  }
}
export function snapshotGroups(
  state: GroupState,
  groups: GroupConversation[],
  cursor: string,
  userId: UserId,
): GroupState {
  let next = state
  const ids = new Set(groups.map((g) => g.id))
  for (const [id, entry] of state.authority)
    if (!ids.has(id) && entry.current && BigInt(cursor) >= BigInt(entry.at))
      next = revokeGroup(next, entry.current.thread, cursor)
  next = { ...next, snapshotFloor: cursor }
  for (const group of groups) next = observeGroup(next, group, cursor, userId, group, true)
  return {
    ...next,
    pending: next.pending.filter((p) => p.thread.kind === 'group' && hasGroup(next, p.thread)),
  }
}
export function groupMessage(
  state: GroupState,
  thread: GroupThread,
  message: GroupMessage,
  live = false,
  countUnread = false,
  eventCursor = message.cursor,
  acknowledge = true,
): GroupState {
  if (
    message.groupId !== thread.id ||
    !hasGroup(state, thread) ||
    (live && BigInt(eventCursor) < BigInt(thread.admission))
  )
    return state
  const entry = state.authority.get(thread.id)
  if (!entry?.current) return state
  const duplicate = state.messages.some((m) => m.id === message.id)
  const canonical = newerMessage(entry.current.group.latest, message)
  const { groupId: _, ...content } = canonical
  const messages = new Map(state.messages.map((m) => [m.id, m]))
  messages.set(message.id, newerMessage(messages.get(message.id), { ...content, thread }))
  const current = entry.current
  const latest = current.group.latest
  return {
    ...state,
    messages: [...messages.values()].sort((a, b) => (BigInt(a.cursor) < BigInt(b.cursor) ? -1 : 1)),
    pending: state.pending.filter(
      (p) =>
        !acknowledge ||
        !(threadKey(p.thread) === threadKey(thread) && p.retryId === message.retryId),
    ),
    authority: new Map(state.authority).set(thread.id, {
      ...entry,
      current: {
        ...current,
        group: {
          ...current.group,
          latest: latestMessage(latest, message),
          unread:
            current.group.unread +
            (live &&
            countUnread &&
            !duplicate &&
            BigInt(message.cursor) > BigInt(current.contentFloor)
              ? 1
              : 0),
        },
      },
    }),
  }
}
export function groupThread(group: GroupMetadata, userId: UserId): GroupThread | null {
  const admission: Admission | undefined = group.members.find((m) => m.userId === userId)?.admission
  return admission ? { kind: 'group', id: group.id, admission } : null
}
