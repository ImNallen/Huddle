import { execFile } from 'node:child_process'
import type { IncomingHttpHeaders } from 'node:http'
import { promisify } from 'node:util'
import { z } from 'zod'
import { PublicUser, TailscaleLogin, type NoIdentityReason } from '@huddle/contracts'
import { AccessFailure } from './access-store'
import { origins, serverHosts } from './config'
import { db } from './db'

export type NoIdentity = { kind: 'no-identity'; reason: NoIdentityReason }
export type Attestation =
  | NoIdentity
  | { kind: 'person'; login: TailscaleLogin; suggestedName: string }
export type Visitor =
  | NoIdentity
  | { kind: 'stranger'; login: TailscaleLogin; suggestedName: string }
  | { kind: 'removed'; login: TailscaleLogin }
  | { kind: 'member'; login: TailscaleLogin; user: PublicUser }
export type Member = Extract<Visitor, { kind: 'member' }>

const Standing = z.enum(['member', 'removed']).nullable()
const encodedWord = /^=\?utf-8\?q\?([^?\s]*)\?=$/i
const utf8 = new TextDecoder('utf-8', { fatal: true })

/** In userspace mode tailscaled forwards a peer's direct connection to this node's IP onto loopback,
 *  past Serve, so the peer could forge identity headers. A sidecar has no CLI here, and compose.yaml
 *  pins its mode instead. */
export async function refuseUserspaceTailscale() {
  const status = await promisify(execFile)(
    'tailscale',
    ['status', '--self', '--peers=false', '--json'],
    { timeout: 5000 },
  ).then(
    ({ stdout }) => z.object({ TUN: z.boolean() }).safeParse(JSON.parse(stdout)),
    () => null,
  )
  if (status?.success && !status.data.TUN)
    throw new Error(
      'Tailscale is running in userspace mode, which lets any peer reach this server directly and claim to be any member. Run tailscaled with a TUN device. On a Proxmox LXC, pass through /dev/net/tun.',
    )
}

/** Serve Q-encodes a value with non-ASCII characters and sends an empty value for invalid UTF-8. */
function decodeHeaderWords(value: string | null): string | null {
  if (!value) return null
  const words = value.split(' ').map((word) => encodedWord.exec(word)?.[1])
  if (!words.every((word) => word !== undefined)) return value
  const bytes = Array.from(words.join('').matchAll(/=([0-9A-Fa-f]{2})|([^=])/g), (match) =>
    match[1]
      ? Number.parseInt(match[1], 16)
      : match[2] === '_'
        ? 0x20
        : (match[2] ?? '').charCodeAt(0),
  )
  try {
    return utf8.decode(new Uint8Array(bytes)) || null
  } catch {
    return null
  }
}

/** The Host check stops DNS rebinding from a browser on the server itself, because a
 *  rebound page can set any header but cannot forge Host. */
export function readAttestation(headers: Headers): Attestation {
  if (headers.has('tailscale-funnel-request')) return { kind: 'no-identity', reason: 'funnel' }
  if (!serverHosts.has(headers.get('host') ?? '')) return { kind: 'no-identity', reason: 'direct' }
  const login = TailscaleLogin.safeParse(decodeHeaderWords(headers.get('tailscale-user-login')))
  if (!login.success)
    return { kind: 'no-identity', reason: headers.has('x-forwarded-host') ? 'no-user' : 'direct' }
  const name = decodeHeaderWords(headers.get('tailscale-user-name'))?.trim()
  return {
    kind: 'person',
    login: login.data,
    suggestedName: (name || login.data.slice(0, login.data.indexOf('@'))).slice(0, 80),
  }
}

export async function identify(headers: Headers): Promise<Visitor> {
  const attestation = readAttestation(headers)
  if (attestation.kind === 'no-identity') return attestation
  const { rows } = await db.query(
    `SELECT u.id, u.name, a.avatar,
      CASE WHEN b.user_id IS NOT NULL THEN 'removed' WHEN m.user_id IS NOT NULL THEN 'member' END AS standing
    FROM "user" u
    JOIN account_security a ON a.user_id = u.id
    LEFT JOIN member m ON m.user_id = u.id
    LEFT JOIN blocked_account b ON b.user_id = u.id
    WHERE u.tailscale_login = $1`,
    [attestation.login],
  )
  const standing = Standing.parse(rows[0]?.standing ?? null)
  switch (standing) {
    case 'member':
      return { kind: 'member', login: attestation.login, user: PublicUser.parse(rows[0]) }
    case 'removed':
      return { kind: 'removed', login: attestation.login }
    case null:
      return { ...attestation, kind: 'stranger' }
  }
}

export async function requireAccess(headers: Headers): Promise<Member> {
  const visitor = await identify(headers)
  if (visitor.kind !== 'member') throw new AccessFailure('no_access')
  return visitor
}

/** Browsers always send Origin on POST and on upgrades, so a write without one is not a page of ours. */
export function contextAllowed(headers: Headers, intent: 'read' | 'write'): boolean {
  const origin = headers.get('origin')
  if (origin) return origins.has(origin)
  if (intent === 'write') return false
  const site = headers.get('sec-fetch-site')
  return site !== 'cross-site' && site !== 'same-site'
}

export function upgradeHeaders(incoming: IncomingHttpHeaders): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(incoming))
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  return headers
}
