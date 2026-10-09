import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import { z } from 'zod'
import { FactorInput } from '@huddle/contracts'
import { auth } from './auth'
import { delivery } from './auth-bridge'
import {
  attach,
  continuation,
  issueSession,
  localAllowed,
  requireAccess,
  respond,
  verifyFactor,
  viewFor,
} from './access'
import {
  AccessFailure,
  limit,
  forgive,
  loadCeremony,
  lockAccount,
  opaque,
  putCeremony,
  transaction,
} from './access-store'
import { db } from './db'
import { config } from './config'

const Base = z.object({
  id: z.string(),
  rawId: z.string(),
  type: z.literal('public-key'),
  clientExtensionResults: z.object({
    credProps: z.object({ rk: z.boolean().optional() }).optional(),
  }),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
})
const Registration = Base.extend({
  response: z.object({
    clientDataJSON: z.string(),
    attestationObject: z.string(),
    transports: z
      .array(z.enum(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']))
      .optional(),
    publicKeyAlgorithm: z.number().optional(),
    publicKey: z.string().optional(),
    authenticatorData: z.string().optional(),
  }),
})
const Authentication = Base.extend({
  response: z.object({
    clientDataJSON: z.string(),
    authenticatorData: z.string(),
    signature: z.string(),
    userHandle: z.string().optional(),
  }),
})
const rpID = new URL(config.SERVER_URL).hostname
async function optionsResponse(request: Request, body: object, token: string) {
  return delivery.run({ view: body, native: false, continuation: token }, () =>
    auth.handler(
      new Request(`${config.SERVER_URL}/api/auth/huddle/response`, { headers: request.headers }),
    ),
  )
}
export async function passkeyRequest(request: Request) {
  localAllowed()
  if (request.method !== 'POST' || request.headers.get('x-huddle-client') === 'native')
    throw new AccessFailure('invalid')
  const path = new URL(request.url).pathname
  const text = await request.text()
  if (text.length > 64000) throw new AccessFailure('invalid')
  const raw: unknown = JSON.parse(text)
  if (path === '/api/access/passkey/register/options') {
    const input = z
      .object({ name: z.string().trim().min(1).max(80), proof: FactorInput.optional() })
      .strict()
      .parse(raw)
    const actor = await requireAccess(request.headers, 'account')
    await limit(`passkey:${actor.user.id}`, 10, 900)
    const options = await generateRegistrationOptions({
      rpName: 'Huddle',
      rpID,
      userName: actor.user.email,
      userID: new TextEncoder().encode(actor.user.id),
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    })
    const token = opaque()
    await transaction(async (sql) => {
      const account = await lockAccount(sql, actor.user.id)
      if (account.epoch !== actor.proof.epoch) throw new AccessFailure('reauth_required')
      if (
        actor.proof.stage !== 'passkey-offer' ||
        Date.now() - actor.proof.proved_at.getTime() > 300000
      ) {
        if (!input.proof) throw new AccessFailure('reauth_required')
        await verifyFactor(sql, actor, input.proof)
      }
      await putCeremony(
        sql,
        token,
        { kind: 'passkey', purpose: 'register', challenge: options.challenge, name: input.name },
        actor.user.id,
        account.epoch,
        actor.session.id,
        300,
      )
    })
    return optionsResponse(request, options, token)
  }
  if (path === '/api/access/passkey/authenticate/options') {
    const input = z
      .object({ purpose: z.enum(['signin', 'reauth']) })
      .strict()
      .parse(raw)
    const actor = input.purpose === 'reauth' ? await requireAccess(request.headers) : null
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' })
    const token = opaque()
    await limit('passkey-options-global', 200, 60)
    await putCeremony(
      db,
      token,
      { kind: 'passkey', purpose: input.purpose, challenge: options.challenge },
      actor?.user.id ?? null,
      actor?.proof.epoch ?? null,
      actor?.session.id ?? null,
      300,
    )
    return optionsResponse(request, options, token)
  }
  const token = await continuation(request)
  const snapshot = await loadCeremony(token)
  if (!token || !snapshot || snapshot.pending.kind !== 'passkey') throw new AccessFailure('expired')
  await limit(`passkey-attempt:${snapshot.id_hash}`, 5, 300)
  if (path === '/api/access/passkey/register/verify') {
    const response = Registration.parse(raw)
    const actor = await requireAccess(request.headers, 'account')
    const session = await transaction(async (sql) => {
      const account = await lockAccount(sql, actor.user.id)
      const ceremony = await loadCeremony(token, sql, true)
      if (
        !ceremony ||
        ceremony.pending.kind !== 'passkey' ||
        ceremony.pending.purpose !== 'register' ||
        ceremony.user_id !== actor.user.id ||
        ceremony.session_id !== actor.session.id ||
        ceremony.epoch !== account.epoch
      )
        throw new AccessFailure('invalid')
      const result = await verifyRegistrationResponse({
        response,
        expectedChallenge: ceremony.pending.challenge,
        expectedOrigin: config.SERVER_URL,
        expectedRPID: rpID,
        requireUserVerification: true,
      }).catch(() => {
        throw new AccessFailure('invalid')
      })
      if (!result.verified || !result.registrationInfo.userVerified)
        throw new AccessFailure('invalid')
      const credential = result.registrationInfo.credential
      await sql.query(
        'INSERT INTO access_passkey(id,user_id,public_key,counter,name,transports) VALUES($1,$2,$3,$4,$5,$6)',
        [
          credential.id,
          actor.user.id,
          Buffer.from(credential.publicKey),
          credential.counter,
          ceremony.pending.name ?? 'Passkey',
          JSON.stringify(credential.transports ?? []),
        ],
      )
      await sql.query('DELETE FROM access_ceremony WHERE id_hash=$1', [ceremony.id_hash])
      await sql.query('UPDATE account_security SET epoch=epoch+1 WHERE user_id=$1', [actor.user.id])
      const rotated = await issueSession(actor.user.id, request)
      await attach(
        sql,
        rotated.session.id,
        actor.user.id,
        account.epoch + 1,
        'passkey',
        account.profile_completed_at ? 'ready' : 'profile',
      )
      await sql.query('DELETE FROM session WHERE id=$1', [actor.session.id])
      return rotated
    })
    const headers = new Headers(request.headers)
    headers.set('authorization', `Bearer ${session.session.token}`)
    return respond(request, await viewFor(new Request(request.url, { headers })), { session })
  }
  if (path !== '/api/access/passkey/authenticate/verify') throw new AccessFailure('invalid')
  const input = z
    .object({ purpose: z.enum(['signin', 'reauth']), response: Authentication })
    .strict()
    .parse(raw)
  const credentialLookup = await db.query('SELECT user_id FROM access_passkey WHERE id=$1', [
    input.response.id,
  ])
  if (!credentialLookup.rows[0]) throw new AccessFailure('invalid')
  const userId = z.string().parse(credentialLookup.rows[0].user_id)
  await limit(`factor:${userId}`, 5, 900)
  const actor = input.purpose === 'reauth' ? await requireAccess(request.headers) : null
  let session: Awaited<ReturnType<typeof issueSession>> | undefined
  const proof = opaque()
  await transaction(async (sql) => {
    const account = await lockAccount(sql, userId)
    const ceremony = await loadCeremony(token, sql, true)
    if (
      !ceremony ||
      ceremony.pending.kind !== 'passkey' ||
      ceremony.pending.purpose !== input.purpose
    )
      throw new AccessFailure('invalid')
    if (
      actor &&
      (ceremony.session_id !== actor.session.id ||
        ceremony.epoch !== account.epoch ||
        actor.user.id !== userId)
    )
      throw new AccessFailure('invalid')
    const stored = await sql.query(
      'SELECT id,public_key,counter FROM access_passkey WHERE id=$1 AND user_id=$2 FOR UPDATE',
      [input.response.id, userId],
    )
    const credential = z
      .object({ id: z.string(), public_key: z.instanceof(Buffer), counter: z.coerce.number() })
      .parse(stored.rows[0])
    const result = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: ceremony.pending.challenge,
      expectedOrigin: config.SERVER_URL,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: {
        id: credential.id,
        publicKey: new Uint8Array(credential.public_key),
        counter: credential.counter,
      },
    }).catch(() => {
      throw new AccessFailure('invalid')
    })
    if (!result.verified || !result.authenticationInfo.userVerified)
      throw new AccessFailure('invalid')
    await sql.query('UPDATE access_passkey SET counter=$2,last_used_at=now() WHERE id=$1', [
      credential.id,
      result.authenticationInfo.newCounter,
    ])
    await sql.query('DELETE FROM access_ceremony WHERE id_hash=$1', [ceremony.id_hash])
    if (input.purpose === 'signin') session = await issueSession(userId, request)
    if (session)
      await attach(
        sql,
        session.session.id,
        userId,
        account.epoch,
        'passkey',
        account.profile_completed_at ? 'ready' : 'profile',
      )
    if (actor)
      await putCeremony(
        sql,
        proof,
        { kind: 'factor-proof', sessionId: actor.session.id },
        userId,
        account.epoch,
        actor.session.id,
        300,
      )
  })
  await forgive(`factor:${userId}`)
  if (!session) return Response.json({ proof })
  const headers = new Headers(request.headers)
  headers.set('authorization', `Bearer ${session.session.token}`)
  return respond(request, await viewFor(new Request(request.url, { headers })), { session })
}
