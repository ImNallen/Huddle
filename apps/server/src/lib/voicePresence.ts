import { RoomServiceClient } from 'livekit-server-sdk'
import { VoicePresence, type UserId } from '@huddle/contracts'
import { config } from './config'

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
    const found = await Promise.all(
      rooms.map(async ({ name }) => ({
        channelId: name,
        participants: (await service.listParticipants(name)).toSorted((first, second) =>
          first.joinedAtMs < second.joinedAtMs ? -1 : first.joinedAtMs > second.joinedAtMs ? 1 : 0,
        ),
      })),
    )
    people = found.flatMap(({ channelId, participants }) => {
      const entry = VoicePresence.element.safeParse({
        channelId,
        people: participants.map(({ identity, name }) => ({ id: identity, name })),
      })
      return entry.success && entry.data.people.length ? [entry.data] : []
    })
    const now = Date.now()
    for (const id of absentSince.keys()) if (watchers.has(id)) absentSince.delete(id)
    for (const { channelId, participants } of found)
      for (const { identity } of participants) {
        if (watchers.has(identity)) continue
        const since = absentSince.get(identity)
        if (since === undefined) absentSince.set(identity, now)
        else if (now - since >= graceMs)
          await service.removeParticipant(channelId, identity).catch(() => {
            console.error({ event: 'voice.removal.failed', channelId, identity })
          })
      }
  }
  async function loop() {
    try {
      await look()
      failing = false
    } catch {
      people = []
      if (!failing) console.error({ event: 'voice.presence.failed', url: voice.adminUrl })
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
