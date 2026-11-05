import { z } from 'zod'

export function serverOrigin(input: string): string {
  const url = new URL(input)
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('Use a server origin without a path or credentials.')
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    throw new Error('Use HTTPS for a remote server. HTTP is allowed only on localhost.')
  return url.origin
}

export const JoinCode = z.string().regex(/^[A-Za-z0-9_-]{20,128}$/)
export type Invite = { origin: string; code: z.infer<typeof JoinCode> }

export function formatInvite(invite: Invite): string {
  return `${serverOrigin(invite.origin)}/#join=${JoinCode.parse(invite.code)}`
}

/** Throws an Error whose message is safe to show. */
export function parseInvite(text: string): Invite {
  const value = text.trim()
  if (value.startsWith('huddle:'))
    throw new Error('This invite is from an older Huddle. Ask for a new one.')
  const incomplete = 'That invite is incomplete. Ask for a new one.'
  if (!URL.canParse(value)) throw new Error('Paste the invite link from your host.')
  const url = new URL(value)
  const code = JoinCode.safeParse(/^#join=(.*)$/.exec(url.hash)?.[1])
  if (!code.success) throw new Error(incomplete)
  url.hash = ''
  try {
    return { origin: serverOrigin(url.href), code: code.data }
  } catch {
    throw new Error(incomplete)
  }
}
