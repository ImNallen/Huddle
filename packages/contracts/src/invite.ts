import { z } from 'zod'

export const Username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_-]{1,31}$/)
export const Password = z.string().min(8).max(200)
export const Invite = z
  .object({
    v: z.literal(1),
    host: z.string().trim().min(1).max(253),
    port: z.number().int().min(1).max(65535),
    code: z.string().regex(/^[A-Za-z0-9_-]{20,128}$/),
    pin: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict()
export type Invite = z.infer<typeof Invite>
export const FriendInvites = z.object({ invites: z.array(z.string().min(1).max(2048)) })

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}
function base64UrlToString(value: string) {
  const pad = value.length % 4 === 0 ? '' : '='.repeat(4 - (value.length % 4))
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + pad)
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}
export function formatInvite(input: Invite) {
  const invite = Invite.parse(input)
  const json = JSON.stringify({
    v: invite.v,
    host: invite.host,
    port: invite.port,
    code: invite.code,
    pin: invite.pin,
  })
  return `huddle:${bytesToBase64Url(new TextEncoder().encode(json))}`
}
export function parseInvite(value: string): Invite {
  const text = value.trim()
  if (!text.startsWith('huddle:'))
    throw new Error('Paste the invite from the person who hosts Huddle.')
  let parsed: unknown
  try {
    parsed = JSON.parse(base64UrlToString(text.slice('huddle:'.length)))
  } catch {
    throw new Error('That invite is incomplete. Ask for a new one.')
  }
  const invite = Invite.safeParse(parsed)
  if (!invite.success) throw new Error('That invite is incomplete. Ask for a new one.')
  return invite.data
}
export function inviteOrigin(invite: Invite) {
  const host = invite.host.includes(':') ? `[${invite.host}]` : invite.host
  return `https://${host}:${invite.port}`
}
