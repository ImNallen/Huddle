import { RoomServiceClient } from 'livekit-server-sdk'
import { VoicePresence, type UserId } from '@huddle/contracts'
import { config } from './config'
import { db } from './db'

const lookEveryMs = 1000

/** Asks LiveKit who is in each room, for the watch sockets to pass on. It also holds calls to the
 *  rule that a person in one keeps a watch socket: Serve attests a socket when it opens, so a person
 *  who no longer passes Tailscale cannot keep one, and a call alone is never re-checked. */
export function startVoicePresence(voice: NonNullable<typeof config.voice>) {
  const service = new RoomServiceClient(voice.adminUrl, voice.key, voice.secret, {
    requestTimeout: 5,
  })
  const graceMs = config.VOICE_ACCESS_GRACE_SECONDS * 1000
  const watchers = new Map<string, number>()
  // Survives a person leaving the call, so rejoining cannot buy another grace period. It holds at most
  // one entry per account.
  const absentSince = new Map<string, number>()
  let people: VoicePresence = []
  let failing = false
  let stopped = false
  let timer: NodeJS.Timeout | undefined

  async function look() {
    const rooms = await service.listRooms()
    // One LiveKit can serve several Huddle servers, as `livekit-dev` does for `pnpm dev` and the
    // suites. Each lists and removes only people in its own channels.
    const { rows: ours } = await db.query<{ id: string; deleted: boolean }>(
      `SELECT id, false AS deleted FROM channel WHERE kind = 'voice' AND id::text = ANY($1)
      UNION ALL SELECT id, true FROM deleted_voice_channel WHERE id::text = ANY($1) ORDER BY id`,
      [rooms.map(({ name }) => name)],
    )
    for (const { id } of ours.filter(({ deleted }) => deleted))
      await service.deleteRoom(id).catch(() => console.error({ event: 'voice.close.failed', id }))
    const live = ours.filter(({ deleted }) => !deleted)
    const found = await Promise.all(
      live.map(async ({ id }) => ({
        channelId: id,
        participants: (await service.listParticipants(id)).toSorted((first, second) =>
          first.joinedAtMs < second.joinedAtMs ? -1 : first.joinedAtMs > second.joinedAtMs ? 1 : 0,
        ),
      })),
    )
    const { rows: members } = await db.query<{ user_id: string }>(
      'SELECT user_id FROM member WHERE user_id = ANY($1)',
      [found.flatMap(({ participants }) => participants.map(({ identity }) => identity))],
    )
    const onServer = new Set(members.map(({ user_id }) => user_id))
    people = found.flatMap(({ channelId, participants }) => {
      const entry = VoicePresence.element.safeParse({
        channelId,
        people: participants
          .filter(({ identity }) => onServer.has(identity))
          .map(({ identity, name }) => ({ id: identity, name })),
      })
      return entry.success && entry.data.people.length ? [entry.data] : []
    })
    const now = Date.now()
    for (const id of absentSince.keys()) if (watchers.has(id)) absentSince.delete(id)
    for (const { channelId, participants } of found)
      for (const { identity } of participants) {
        if (onServer.has(identity)) {
          if (watchers.has(identity)) continue
          const since = absentSince.get(identity)
          if (since === undefined) absentSince.set(identity, now)
          if (since === undefined || now - since < graceMs) continue
        }
        await service.removeParticipant(channelId, identity).catch(() => {
          console.error({ event: 'voice.removal.failed', channelId, identity })
        })
      }
  }
  async function loop() {
    try {
      await look()
      failing = false
    } catch (error) {
      people = []
      if (!failing) console.error({ event: 'voice.presence.failed', url: voice.adminUrl, error })
      failing = true
    }
    if (!stopped) timer = setTimeout(() => void loop(), lookEveryMs)
  }
  void loop()

  return {
    people: () => people,
    /** Counts one open socket for this account until the returned function runs. */
    watching(id: UserId) {
      watchers.set(id, (watchers.get(id) ?? 0) + 1)
      return () => {
        const left = (watchers.get(id) ?? 1) - 1
        if (left) watchers.set(id, left)
        else watchers.delete(id)
      }
    },
    close() {
      stopped = true
      clearTimeout(timer)
    },
  }
}
