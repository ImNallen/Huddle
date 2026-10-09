import { z } from 'zod'

export const MascotShape = z.enum(['circle', 'square', 'bean', 'hexagon', 'triangle', 'flower'])
export const MascotColor = z.enum([
  'indigo',
  'sky',
  'teal',
  'lime',
  'amber',
  'orange',
  'rose',
  'violet',
])
export const Avatar = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('mascot'), shape: MascotShape, color: MascotColor }).strict(),
  z.object({ kind: z.literal('photo'), uploadId: z.uuid() }).strict(),
])

export const WorkspaceId = z.uuid().brand<'WorkspaceId'>()
export const ChannelId = z.uuid().brand<'ChannelId'>()
export const UserId = z.string().min(1).brand<'UserId'>()
export const Cursor = z.string().regex(/^(0|[1-9][0-9]{0,18})$/)
export const Workspace = z.object({
  id: WorkspaceId,
  name: z.string(),
  role: z.enum(['owner', 'member']),
  memberCount: z.number().int().nonnegative(),
  channelCount: z.number().int().nonnegative(),
})
export const Channel = z.object({ id: ChannelId, workspaceId: WorkspaceId, name: z.string() })
export const Message = z.object({
  id: z.uuid(),
  channelId: ChannelId,
  authorId: UserId,
  authorName: z.string(),
  authorAvatar: Avatar.nullish(),
  retryId: z.uuid(),
  body: z.string(),
  cursor: Cursor,
  createdAt: z.string(),
})
export const WorkspaceEvent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('channel.created'), cursor: Cursor, channel: Channel }),
  z.object({ kind: z.literal('message.created'), cursor: Cursor, message: Message }),
])
export const WatchFrame = z
  .object({
    kind: z.literal('watch'),
    workspaceId: WorkspaceId,
    after: Cursor,
    token: z.string().min(1).max(4096).optional(),
    ticket: z.string().length(43).optional(),
  })
  .strict()
export const EventPage = z.object({ kind: z.literal('events'), events: z.array(WorkspaceEvent) })
export const Snapshot = z.object({
  workspace: Workspace,
  channels: z.array(Channel),
  cursor: Cursor,
})
export const SendMessage = z
  .object({ channelId: ChannelId, retryId: z.uuid(), body: z.string().trim().min(1).max(8000) })
  .strict()
export const CreateChannel = z
  .object({
    workspaceId: WorkspaceId,
    name: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  })
  .strict()
export const CreateWorkspace = z.object({ name: z.string().trim().min(1).max(60) }).strict()
export const InvitationCode = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
export const Session = z.object({
  user: z.object({ id: UserId, name: z.string(), email: z.email(), avatar: Avatar }),
})
export const ServerInfo = z.object({
  name: z.string(),
  emailAvailable: z.boolean(),
  websocketUrl: z.url(),
  oidc: z.boolean(),
  policy: z.enum(['mixed', 'sso-only']),
})
export const DeviceCode = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  verification_uri_complete: z.string().optional(),
  expires_in: z.number(),
  interval: z.number(),
})
export const DeviceToken = z.object({ access_token: z.string() })
export type Workspace = z.infer<typeof Workspace>
export type Channel = z.infer<typeof Channel>
export type Message = z.infer<typeof Message>
export type WorkspaceEvent = z.infer<typeof WorkspaceEvent>
export type Snapshot = z.infer<typeof Snapshot>
export type Session = z.infer<typeof Session>
export type WorkspaceId = z.infer<typeof WorkspaceId>
export type ChannelId = z.infer<typeof ChannelId>
export type UserId = z.infer<typeof UserId>

export function serverOrigin(input: string): string {
  const url = new URL(input)
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('Use a server origin without a path or credentials.')
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    throw new Error('Use HTTPS for a remote server. HTTP is allowed only on localhost.')
  return url.origin
}

export const Profile = z.object({ name: z.string().trim().min(1).max(80), avatar: Avatar }).strict()
export const PublicUser = Session.shape.user.extend({ avatar: Avatar })
export const AccessMethod = z.enum(['email', 'passkey', 'company'])
export const RecoveryBatch = z.object({
  kind: z.literal('save-recovery'),
  batch: z.uuid(),
  codes: z.array(z.string()),
})
export const AccessStage = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('signin'), methods: z.array(AccessMethod) }),
  z.object({
    kind: z.literal('email'),
    email: z.email(),
    expiresAt: z.iso.datetime(),
    resendAt: z.iso.datetime(),
  }),
  z.object({
    kind: z.literal('enroll'),
    secret: z.string(),
    uri: z.string(),
    generation: z.uuid(),
    replacing: z.boolean(),
  }),
  z.object({ kind: z.literal('totp'), user: Session.shape.user }),
  z.object({ kind: z.literal('recovery'), user: Session.shape.user }),
  RecoveryBatch,
  z.object({ kind: z.literal('passkey-offer') }),
  z.object({ kind: z.literal('profile'), profile: Profile }),
  z.object({ kind: z.literal('ready'), user: PublicUser }),
])
export const FactorInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('totp'), code: z.string().regex(/^\d{6}$/) }).strict(),
  z.object({ kind: z.literal('passkey'), proof: z.string().min(1).max(512) }).strict(),
])
export const SecurityChange = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('passkey.rename'),
      id: z.string().min(1).max(512),
      name: z.string().trim().min(1).max(80),
    })
    .strict(),
  z.object({ kind: z.literal('authenticator.replace') }).strict(),
  z.object({ kind: z.literal('recovery.regenerate') }).strict(),
  z.object({ kind: z.literal('passkey.remove'), id: z.string().min(1).max(512) }).strict(),
  z.object({ kind: z.literal('session.revoke'), id: z.string().min(1).max(512) }).strict(),
  z.object({ kind: z.literal('sessions.revoke-others') }).strict(),
])
export const AccessCommand = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('email.send'), email: z.email().max(254) }).strict(),
  z.object({ kind: z.literal('email.verify'), code: z.string().regex(/^\d{6}$/) }).strict(),
  z.object({ kind: z.literal('totp.verify'), code: z.string().regex(/^\d{6}$/) }).strict(),
  z.object({ kind: z.literal('recovery.verify'), code: z.string().min(1).max(128) }).strict(),
  z.object({ kind: z.literal('enrollment.refresh') }).strict(),
  z
    .object({
      kind: z.literal('enrollment.verify'),
      generation: z.uuid(),
      code: z.string().regex(/^\d{6}$/),
    })
    .strict(),
  z.object({ kind: z.literal('recovery.choose') }).strict(),
  z.object({ kind: z.literal('recovery.ack'), batch: z.uuid() }).strict(),
  z.object({ kind: z.literal('passkey.skip') }).strict(),
  z.object({ kind: z.literal('profile.save'), profile: Profile }).strict(),
  z
    .object({
      kind: z.literal('device.decide'),
      userCode: z.string().min(1).max(32),
      decision: z.enum(['approve', 'deny']),
    })
    .strict(),
  z
    .object({ kind: z.literal('security.commit'), change: SecurityChange, proof: FactorInput })
    .strict(),
  z.object({ kind: z.literal('reset.request'), email: z.email().max(254) }).strict(),
  z.object({ kind: z.literal('reset.redeem'), capability: z.string().min(1).max(512) }).strict(),
  z.object({ kind: z.literal('signout') }).strict(),
])
export const AccessView = z.object({
  stage: AccessStage,
  bearerToken: z.string().optional(),
  continuation: z.string().optional(),
})
export const AccessError = z.object({
  error: z.enum(['invalid', 'expired', 'rate_limited', 'unavailable', 'reauth_required']),
  retryAt: z.iso.datetime().optional(),
})
export const AccountSecurity = z.object({
  user: PublicUser,
  policy: z.enum(['mixed', 'sso-only']),
  authenticator: z.object({ enrolledAt: z.iso.datetime() }).nullable(),
  recoveryCreatedAt: z.iso.datetime().nullable(),
  recoveryTotal: z.number().int().nonnegative(),
  recoveryRemaining: z.number().int().nonnegative(),
  passkeys: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      createdAt: z.iso.datetime(),
      lastUsedAt: z.iso.datetime().nullable(),
    }),
  ),
  sessions: z.array(
    z.object({
      id: z.string(),
      current: z.boolean(),
      method: z.enum(['totp', 'recovery', 'passkey', 'company']),
      createdAt: z.iso.datetime(),
      expiresAt: z.iso.datetime(),
      userAgent: z.string().nullable(),
    }),
  ),
})
export const PhotoUpload = z.object({ uploadId: z.uuid() })
export const PasskeyProof = z.object({ proof: z.string() })
export type Avatar = z.infer<typeof Avatar>
export type Profile = z.infer<typeof Profile>
export type PublicUser = z.infer<typeof PublicUser>
export type AccessStage = z.infer<typeof AccessStage>
export type AccessCommand = z.infer<typeof AccessCommand>
export type AccessView = z.infer<typeof AccessView>
export type AccessError = z.infer<typeof AccessError>
export type FactorInput = z.infer<typeof FactorInput>
export type SecurityChange = z.infer<typeof SecurityChange>
export type AccountSecurity = z.infer<typeof AccountSecurity>
