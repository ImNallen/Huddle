import { AsyncLocalStorage } from 'node:async_hooks'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { z } from 'zod'
import { config } from './config'
import {
  AccessFailure,
  digest,
  loadCeremony,
  lockAccount,
  opaque,
  putCeremony,
  transaction,
} from './access-store'

export const providerRequest = new AsyncLocalStorage<{
  subject?: string
  issuer?: string
  firstPasskeyToken?: string | null
}>()
const Discovery = z.object({
  issuer: z.url(),
  jwks_uri: z.url(),
  userinfo_endpoint: z.url().optional(),
})
let metadata: Promise<z.infer<typeof Discovery>> | undefined
export async function companyUser(tokens: { idToken?: string; accessToken?: string }) {
  if (!tokens.idToken || !config.OIDC_DISCOVERY_URL || !config.OIDC_CLIENT_ID) return null
  metadata ??= fetch(config.OIDC_DISCOVERY_URL, { signal: AbortSignal.timeout(5000) })
    .then(async (response) => {
      if (!response.ok) throw new Error('OIDC discovery unavailable')
      return Discovery.parse(await response.json())
    })
    .catch((error: unknown) => {
      metadata = undefined
      throw error
    })
  const discovery = await metadata
  const verified = await jwtVerify(
    tokens.idToken,
    createRemoteJWKSet(new URL(discovery.jwks_uri)),
    {
      issuer: discovery.issuer,
      audience: config.OIDC_CLIENT_ID,
      requiredClaims: ['sub', 'exp', 'iat', 'email', 'email_verified'],
    },
  ).catch(() => null)
  if (!verified) return null
  const parsed = z
    .object({
      sub: z.string().min(1),
      email: z.email(),
      email_verified: z.literal(true),
      name: z.string().optional(),
    })
    .safeParse(verified.payload)
  if (!parsed.success) return null
  const claims = parsed.data
  const request = providerRequest.getStore()
  if (!request) return null
  request.subject = claims.sub
  request.issuer = discovery.issuer
  return {
    sub: claims.sub,
    email: claims.email,
    emailVerified: true,
    name: claims.name ?? claims.email.split('@')[0],
  }
}
export async function companySession(session: { id: string; userId: string }) {
  const subject = providerRequest.getStore()?.subject
  if (!subject) return
  await transaction(async (sql) => {
    const account = await lockAccount(sql, session.userId)
    const linked = await sql.query(
      'SELECT id FROM account WHERE "userId"=$1 AND "providerId"=\'company\' AND "accountId"=$2',
      [session.userId, subject],
    )
    if (!linked.rowCount) throw new Error('Verified company identity does not own this account')
    const issuer = providerRequest.getStore()?.issuer
    const established = await sql.query(
      'SELECT company_issuer FROM account_security WHERE user_id=$1',
      [session.userId],
    )
    if (
      !issuer ||
      (established.rows[0].company_issuer && established.rows[0].company_issuer !== issuer)
    )
      throw new AccessFailure('invalid')
    await sql.query(
      'UPDATE account_security SET company_established_at=now(),company_issuer=$2 WHERE user_id=$1',
      [session.userId, issuer],
    )
    const factors = await sql.query(
      'SELECT 1 FROM local_factor WHERE user_id=$1 UNION ALL SELECT 1 FROM access_passkey WHERE user_id=$1',
      [session.userId],
    )
    let firstPasskey = false
    const token = providerRequest.getStore()?.firstPasskeyToken
    if (token) {
      const pending = await loadCeremony(token, sql, true).catch((error) => {
        if (error instanceof AccessFailure && error.code === 'expired') return null
        throw error
      })
      if (
        pending?.pending.kind === 'company-passkey' ||
        pending?.pending.kind === 'company-session'
      ) {
        const live = await sql.query(
          'SELECT 1 FROM session s JOIN session_proof p ON p.session_id=s.id WHERE s.id=$1 AND s."userId"=$2 AND s."expiresAt">now() AND p.epoch=$3 AND p.stage=\'ready\'',
          [pending.session_id, session.userId, account.epoch],
        )
        if (
          pending.user_id !== session.userId ||
          pending.epoch !== account.epoch ||
          !live.rowCount ||
          (pending.pending.kind === 'company-passkey' && factors.rowCount)
        )
          throw new AccessFailure('reauth_required')
        if (pending.pending.kind === 'company-session') {
          const change = pending.pending.change
          if (change.kind === 'session.revoke') {
            const revoked = await sql.query('DELETE FROM session WHERE id=$1 AND "userId"=$2', [
              change.id,
              session.userId,
            ])
            if (!revoked.rowCount) throw new AccessFailure('invalid')
          } else
            await sql.query('DELETE FROM session WHERE "userId"=$1 AND id<>$2', [
              session.userId,
              session.id,
            ])
          await sql.query('DELETE FROM session WHERE id=$1', [pending.session_id])
          await sql.query('UPDATE account_security SET epoch=epoch+1 WHERE user_id=$1', [
            session.userId,
          ])
          account.epoch += 1
        } else firstPasskey = true
        await sql.query('DELETE FROM access_ceremony WHERE id_hash=$1', [digest(token)])
      }
    }
    let stage =
      config.AUTH_POLICY === 'mixed' &&
      !factors.rowCount &&
      (!account.profile_completed_at || firstPasskey)
        ? 'passkey-offer'
        : account.profile_completed_at
          ? 'ready'
          : 'profile'
    if (account.recovery_pending) stage = 'save-recovery'
    await sql.query(
      "INSERT INTO session_proof(session_id,user_id,epoch,method,stage) VALUES($1,$2,$3,'company',$4)",
      [session.id, session.userId, account.epoch, stage],
    )
  })
}

export async function companyRequest(request: Request) {
  const { auth } = await import('./auth')
  const { continuation, requireAccess } = await import('./access')
  const path = new URL(request.url).pathname
  let providerInput = request
  let token: string | undefined
  if (path === '/api/auth/sign-in/oauth2') {
    const common = { providerId: z.literal('company'), callbackURL: z.string().default('/') }
    const input = z
      .union([
        z.object(common).strict(),
        z.object({ ...common, purpose: z.literal('first-passkey') }).strict(),
        z
          .object({
            ...common,
            purpose: z.literal('session-security'),
            change: z.discriminatedUnion('kind', [
              z
                .object({ kind: z.literal('session.revoke'), id: z.string().min(1).max(512) })
                .strict(),
              z.object({ kind: z.literal('sessions.revoke-others') }).strict(),
            ]),
          })
          .strict(),
      ])
      .parse(await request.json())
    const callback = new URL(input.callbackURL, config.SERVER_URL)
    if (callback.origin !== config.SERVER_URL) throw new AccessFailure('invalid')
    if ('purpose' in input) {
      if (input.purpose === 'first-passkey' && config.AUTH_POLICY !== 'mixed')
        throw new AccessFailure('unavailable')
      const actor = await requireAccess(request.headers)
      if (input.purpose === 'session-security' && actor.proof.method !== 'company')
        throw new AccessFailure('reauth_required')
      token = opaque()
      const pendingToken = token
      await transaction(async (sql) => {
        const account = await lockAccount(sql, actor.user.id)
        const factors = await sql.query(
          'SELECT 1 FROM local_factor WHERE user_id=$1 UNION ALL SELECT 1 FROM access_passkey WHERE user_id=$1',
          [actor.user.id],
        )
        if (
          (input.purpose === 'first-passkey' && factors.rowCount) ||
          account.epoch !== actor.proof.epoch
        )
          throw new AccessFailure('invalid')
        await putCeremony(
          sql,
          pendingToken,
          input.purpose === 'first-passkey'
            ? { kind: 'company-passkey' }
            : { kind: 'company-session', change: input.change },
          actor.user.id,
          account.epoch,
          actor.session.id,
          300,
        )
      })
    }
    providerInput = new Request(`${config.SERVER_URL}/api/auth/sign-in/social`, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify({ provider: 'company', callbackURL: callback.href }),
    })
  }
  const response = await providerRequest.run(
    { firstPasskeyToken: await continuation(request) },
    () => auth.handler(providerInput),
  )
  if (token) {
    const { delivery } = await import('./auth-bridge')
    const cookieResponse = await delivery.run(
      { view: {}, native: false, continuation: token },
      () =>
        auth.handler(
          new Request(`${config.SERVER_URL}/api/auth/huddle/response`, {
            headers: request.headers,
          }),
        ),
    )
    for (const cookie of cookieResponse.headers.getSetCookie())
      response.headers.append('set-cookie', cookie)
  }
  return response
}
