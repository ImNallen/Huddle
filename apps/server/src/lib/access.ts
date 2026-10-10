import { randomInt, randomUUID } from 'node:crypto'
import { TOTP, Secret } from 'otpauth'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import {
  AccessCommand,
  AccessView,
  RecoveryBatch,
  type AccessStage,
  Avatar,
  Inviter,
  PublicUser,
  type FactorInput,
} from '@huddle/contracts'
import { auth } from './auth'
import { delivery } from './auth-bridge'
import { config } from './config'
import { db } from './db'
import { emailRecipient } from './email-config'
import {
  admitEmail,
  checkSetupCode,
  mayReceiveCode,
  sendEmail,
  serverName,
  setupHash,
  setupRequired,
  type Admission,
} from './admission'
import {
  AccessFailure,
  digest,
  forgive,
  limit,
  loadCeremony,
  lockAccount,
  opaque,
  open,
  putCeremony,
  seal,
  transaction,
  type Pending,
} from './access-store'

const Proof = z.object({
  epoch: z.number(),
  method: z.enum(['totp', 'recovery', 'passkey', 'company']),
  stage: z.enum(['save-recovery', 'passkey-offer', 'profile', 'ready']),
  proved_at: z.date(),
  avatar: Avatar,
  recovery_pending: z.string().nullable(),
})
export async function requireAccess(headers: Headers, purpose: 'server' | 'account' = 'server') {
  const session = await auth.api.getSession({ headers })
  if (!session) throw new AccessFailure('reauth_required')
  const result = await db.query(
    `SELECT p.*,a.avatar,a.recovery_pending FROM session_proof p JOIN account_security a ON a.user_id=p.user_id AND a.epoch=p.epoch
    WHERE p.session_id=$1 AND p.user_id=$2`,
    [session.session.id, session.user.id],
  )
  if (!result.rows[0]) throw new AccessFailure('reauth_required')
  const proof = Proof.parse(result.rows[0])
  if (proof.recovery_pending) proof.stage = 'save-recovery'
  if (config.AUTH_POLICY === 'sso-only' && proof.method !== 'company')
    throw new AccessFailure('reauth_required')
  if (purpose === 'server' && proof.stage !== 'ready') throw new AccessFailure('reauth_required')
  return { ...session, user: PublicUser.parse({ ...session.user, avatar: proof.avatar }), proof }
}
export type Principal = Awaited<ReturnType<typeof requireAccess>>
async function optionalPrincipal(request: Request) {
  try {
    return await requireAccess(request.headers, 'account')
  } catch (error) {
    if (error instanceof AccessFailure) return null
    throw error
  }
}
export function localAllowed() {
  if (config.AUTH_POLICY !== 'mixed') throw new AccessFailure('unavailable')
}
export async function continuation(request: Request) {
  if (request.headers.get('x-huddle-client') === 'native')
    return request.headers.get('x-huddle-continuation')
  const result = await auth.api.huddleContinuation({ headers: request.headers })
  return result.continuation
}
export async function respond(
  request: Request,
  view: AccessView,
  options: {
    token?: string
    session?: NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>
    clear?: boolean
  } = {},
) {
  const native = request.headers.get('x-huddle-client') === 'native'
  if (native && options.token) view.continuation = options.token
  if (native && options.session) view.bearerToken = options.session.session.token
  return delivery.run(
    { view, native, continuation: options.token, session: options.session, clear: options.clear },
    () =>
      auth.handler(
        new Request(`${config.SERVER_URL}/api/auth/huddle/response`, { headers: request.headers }),
      ),
  )
}
async function publicUser(userId: string) {
  const result = await db.query(
    'SELECT u.id,u.name,u.email,a.avatar FROM "user" u JOIN account_security a ON a.user_id=u.id WHERE u.id=$1',
    [userId],
  )
  return PublicUser.parse(result.rows[0])
}
async function inviter(userId: string) {
  const result = await db.query(
    `SELECT u.name,u.email,a.avatar,m.role FROM invitation i JOIN "user" u ON u.id=i.invited_by
    JOIN account_security a ON a.user_id=u.id JOIN member m ON m.user_id=u.id
    WHERE i.accepted_by=$1 ORDER BY i.accepted_at DESC LIMIT 1`,
    [userId],
  )
  return result.rows[0] ? Inviter.parse(result.rows[0]) : null
}
async function entry(): Promise<AccessStage> {
  const company = config.OIDC_DISCOVERY_URL ? (['company'] as const) : []
  const local = config.AUTH_POLICY === 'mixed'
  if (await setupRequired())
    return { kind: 'setup', methods: local ? ['email', ...company] : ['company'] }
  return { kind: 'signin', methods: local ? ['email', 'passkey', ...company] : ['company'] }
}
export async function viewFor(request: Request): Promise<AccessView> {
  const principal = await optionalPrincipal(request)
  if (principal?.proof.recovery_pending)
    return { stage: await open(principal.proof.recovery_pending, RecoveryBatch) }
  const pending = await loadCeremony(await continuation(request)).catch((error) => {
    if (error instanceof AccessFailure && error.code === 'expired') return null
    throw error
  })
  if (
    config.AUTH_POLICY === 'mixed' &&
    pending &&
    (!pending.session_id || pending.session_id === principal?.session.id)
  ) {
    if (pending.user_id) {
      const epoch = await db.query('SELECT epoch FROM account_security WHERE user_id=$1', [
        pending.user_id,
      ])
      if (epoch.rows[0]?.epoch !== pending.epoch) return { stage: await entry() }
    }
    switch (pending.pending.kind) {
      case 'email':
        return {
          stage: {
            kind: 'email',
            email: pending.pending.email,
            expiresAt: pending.expires_at.toISOString(),
            resendAt: pending.pending.resendAt,
          },
        }
      case 'enroll':
        return {
          stage: {
            kind: 'enroll',
            secret: pending.pending.secret,
            generation: pending.pending.generation,
            replacing: pending.pending.replacing,
            uri: totp(pending.pending.secret, await serverName()).toString(),
            inviter:
              pending.user_id && !pending.pending.replacing ? await inviter(pending.user_id) : null,
          },
        }
      case 'totp':
      case 'recovery':
        if (pending.user_id)
          return { stage: { kind: pending.pending.kind, user: await publicUser(pending.user_id) } }
        break
      case 'save-recovery':
        break
    }
  }
  if (!principal) return { stage: await entry() }
  if (principal.proof.stage === 'save-recovery') throw new AccessFailure('expired')
  if (principal.proof.stage === 'passkey-offer') return { stage: { kind: 'passkey-offer' } }
  if (principal.proof.stage === 'profile')
    return {
      stage: {
        kind: 'profile',
        profile: { name: principal.user.name, avatar: principal.user.avatar },
      },
    }
  return { stage: { kind: 'ready', user: principal.user } }
}
export const totp = (secret: string, label = 'Huddle account') =>
  new TOTP({
    issuer: 'Huddle',
    label,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  })
function enrollment(
  replacing: boolean,
  extra: { recoveryHash?: string; resetId?: string } = {},
): Pending {
  return {
    kind: 'enroll',
    secret: new Secret({ size: 20 }).base32,
    generation: randomUUID(),
    replacing,
    ...extra,
  }
}
export async function issueSession(userId: string, request: Request) {
  const ctx = await auth.$context
  const user = await ctx.internalAdapter.findUserById(userId)
  if (!user) throw new AccessFailure('invalid')
  const session = await ctx.internalAdapter.createSession(userId, false, {
    userAgent: request.headers.get('user-agent') ?? '',
  })
  if (!session) throw new AccessFailure('unavailable')
  return { user, session }
}
export async function attach(
  sql: PoolClient,
  sessionId: string,
  userId: string,
  epoch: number,
  method: 'totp' | 'recovery' | 'passkey' | 'company',
  stage: 'save-recovery' | 'passkey-offer' | 'profile' | 'ready',
) {
  const account = await sql.query(
    'SELECT recovery_pending FROM account_security WHERE user_id=$1',
    [userId],
  )
  if (account.rows[0]?.recovery_pending) stage = 'save-recovery'
  await sql.query(
    `INSERT INTO session_proof(session_id,user_id,epoch,method,stage) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(session_id) DO UPDATE SET epoch=$3,method=$4,stage=$5,proved_at=now()`,
    [sessionId, userId, epoch, method, stage],
  )
}
async function recoveryBatch(sql: PoolClient, userId: string) {
  const batch = randomUUID()
  const codes = Array.from({ length: 10 }, () => opaque().slice(0, 20))
  await sql.query('DELETE FROM recovery_code WHERE user_id=$1', [userId])
  for (const code of codes)
    await sql.query('INSERT INTO recovery_code(user_id,batch,code_hash) VALUES($1,$2,$3)', [
      userId,
      batch,
      digest(`recovery:${code}`),
    ])
  const pending = { kind: 'save-recovery' as const, batch, codes }
  await sql.query('UPDATE account_security SET recovery_pending=$2 WHERE user_id=$1', [
    userId,
    await seal(pending),
  ])
  return pending
}
export async function verifyFactor(sql: PoolClient, principal: Principal, factor: FactorInput) {
  await limit(`factor:${principal.user.id}`, 5, 900)
  const account = await lockAccount(sql, principal.user.id)
  if (account.epoch !== principal.proof.epoch) throw new AccessFailure('reauth_required')
  const live = await sql.query('SELECT 1 FROM session WHERE id=$1 AND \"expiresAt\">now()', [
    principal.session.id,
  ])
  if (!live.rowCount) throw new AccessFailure('reauth_required')
  if (factor.kind === 'passkey') {
    const proof = await loadCeremony(factor.proof, sql, true)
    if (
      !proof ||
      proof.user_id !== principal.user.id ||
      proof.epoch !== account.epoch ||
      proof.pending.kind !== 'factor-proof' ||
      proof.pending.sessionId !== principal.session.id
    )
      throw new AccessFailure('invalid')
    await sql.query('DELETE FROM access_ceremony WHERE id_hash=$1', [proof.id_hash])
    await forgive(`factor:${principal.user.id}`)
    return account
  }
  await verifyTotp(sql, principal.user.id, factor.code)
  await forgive(`factor:${principal.user.id}`)
  return account
}
async function verifyTotp(sql: PoolClient, userId: string, code: string) {
  const result = await sql.query(
    'SELECT encrypted_secret,last_step FROM local_factor WHERE user_id=$1 FOR UPDATE',
    [userId],
  )
  if (!result.rows[0]) throw new AccessFailure('invalid')
  const row = z
    .object({ encrypted_secret: z.string(), last_step: z.coerce.number() })
    .parse(result.rows[0])
  const secret = await open(row.encrypted_secret, z.string())
  const delta = totp(secret).validate({ token: code, window: 1 })
  const step = Math.floor(Date.now() / 30000) + (delta ?? 0)
  if (delta === null || step <= row.last_step) throw new AccessFailure('invalid')
  await sql.query('UPDATE local_factor SET last_step=$2 WHERE user_id=$1', [userId, step])
}
async function advance(
  request: Request,
  command: z.infer<typeof AccessCommand>,
): Promise<Response> {
  const oldToken = await continuation(request)
  const actor = await optionalPrincipal(request)
  if (command.kind === 'signout') {
    if (actor) await db.query('DELETE FROM session WHERE id=$1', [actor.session.id])
    if (oldToken) await db.query('DELETE FROM access_ceremony WHERE id_hash=$1', [digest(oldToken)])
    return respond(request, { stage: await entry() }, { clear: true })
  }
  if (command.kind === 'reset.request') {
    localAllowed()
    await limit(`reset:${command.email.toLowerCase()}`, 3, 3600)
    await db.query('INSERT INTO account_reset(id,email) VALUES($1,$2)', [
      randomUUID(),
      command.email.toLowerCase(),
    ])
    return respond(request, await viewFor(request))
  }
  if (
    command.kind === 'email.send' ||
    command.kind === 'setup.start' ||
    command.kind === 'reset.redeem'
  ) {
    localAllowed()
    let email: string
    let resetId: string | undefined
    let admission: Admission = { kind: 'account' }
    if (command.kind === 'setup.start') {
      await checkSetupCode(command.code)
      email = command.email.toLowerCase()
      admission = {
        kind: 'setup',
        serverName: command.serverName,
        setupHash: setupHash(command.code),
      }
    } else if (command.kind === 'reset.redeem') {
      const row = await db.query(
        'SELECT id,email FROM account_reset WHERE capability_hash=$1 AND expires_at>now() AND used_at IS NULL',
        [digest(`reset:${command.capability}`)],
      )
      if (!row.rows[0]) throw new AccessFailure('invalid')
      const reset = z.object({ id: z.string(), email: z.email() }).parse(row.rows[0])
      email = reset.email
      resetId = reset.id
    } else {
      email = command.email.toLowerCase()
      const previous = await loadCeremony(oldToken).catch((error) => {
        if (error instanceof AccessFailure && error.code === 'expired') return null
        throw error
      })
      if (previous?.pending.kind === 'email' && previous.pending.email === email)
        admission = previous.pending.admission
      if (
        previous?.pending.kind === 'email' &&
        previous.pending.email === email &&
        previous.pending.resetId
      ) {
        const reset = await db.query(
          'SELECT id FROM account_reset WHERE id=$1 AND email=$2 AND expires_at>now() AND used_at IS NULL',
          [previous.pending.resetId, email],
        )
        if (reset.rowCount) resetId = previous.pending.resetId
      }
    }
    await limit(`email-cooldown:${email}`, 1, 60)
    await limit(`email-send:${email}`, 10, 3600)
    const token = opaque()
    const code = String(randomInt(0, 1000000)).padStart(6, '0')
    await putCeremony(
      db,
      token,
      {
        kind: 'email',
        email,
        codeHash: digest(`${token}:${code}`),
        resendAt: new Date(Date.now() + 60000).toISOString(),
        resetId,
        admission,
      },
      null,
      null,
      null,
      300,
    )
    try {
      const recipient = emailRecipient(email)
      const name = await serverName()
      await sendEmail(
        admission.kind === 'setup' || (await mayReceiveCode(email))
          ? { kind: 'authentication-code', recipient, serverName: name, code, purpose: 'sign-in' }
          : { kind: 'no-account', recipient, serverName: name },
      )
    } catch {
      await db.query('DELETE FROM access_ceremony WHERE id_hash=$1', [digest(token)])
      throw new AccessFailure('unavailable')
    }
    const headers = new Headers(request.headers)
    headers.set('x-huddle-client', 'native')
    headers.set('x-huddle-continuation', token)
    return respond(request, await viewFor(new Request(request.url, { headers })), { token })
  }
  if (command.kind === 'recovery.ack') {
    if (!actor || actor.proof.stage !== 'save-recovery') throw new AccessFailure('reauth_required')
    await transaction(async (sql) => {
      const account = await lockAccount(sql, actor.user.id)
      if (account.epoch !== actor.proof.epoch || !account.recovery_pending)
        throw new AccessFailure('invalid')
      const pending = await open(account.recovery_pending, RecoveryBatch)
      if (pending.batch !== command.batch) throw new AccessFailure('invalid')
      await sql.query('UPDATE account_security SET recovery_pending=NULL WHERE user_id=$1', [
        actor.user.id,
      ])
      await sql.query(
        "UPDATE session_proof SET stage=$3 WHERE user_id=$1 AND epoch=$2 AND stage='save-recovery'",
        [
          actor.user.id,
          account.epoch,
          account.profile_completed_at
            ? 'ready'
            : config.AUTH_POLICY === 'sso-only'
              ? 'profile'
              : 'passkey-offer',
        ],
      )
      if (oldToken)
        await sql.query('DELETE FROM access_ceremony WHERE id_hash=$1', [digest(oldToken)])
    })
    return respond(request, await viewFor(request))
  }
  if (command.kind === 'profile.save') {
    if (!actor || !['profile', 'ready'].includes(actor.proof.stage))
      throw new AccessFailure('reauth_required')
    await transaction(async (sql) => {
      const account = await lockAccount(sql, actor.user.id)
      if (account.epoch !== actor.proof.epoch) throw new AccessFailure('reauth_required')
      if (command.profile.avatar.kind === 'photo') {
        const photo = await sql.query('SELECT id FROM account_photo WHERE id=$1 AND user_id=$2', [
          command.profile.avatar.uploadId,
          actor.user.id,
        ])
        if (!photo.rowCount) throw new AccessFailure('invalid')
      }
      await sql.query('UPDATE "user" SET name=$2,"updatedAt"=now() WHERE id=$1', [
        actor.user.id,
        command.profile.name,
      ])
      await sql.query(
        'UPDATE account_security SET avatar=$2,profile_completed_at=now() WHERE user_id=$1',
        [actor.user.id, JSON.stringify(command.profile.avatar)],
      )
      await sql.query("UPDATE session_proof SET stage='ready' WHERE session_id=$1", [
        actor.session.id,
      ])
    })
    return respond(request, { stage: { kind: 'ready', user: await publicUser(actor.user.id) } })
  }
  if (command.kind === 'device.decide') {
    const { decideDevice } = await import('./access-device')
    await decideDevice(request, command.userCode, command.decision)
    return respond(request, await viewFor(request))
  }
  if (command.kind === 'security.commit') {
    localAllowed()
    if (!actor || actor.proof.stage !== 'ready') throw new AccessFailure('reauth_required')
    const token = opaque()
    let rotated: Awaited<ReturnType<typeof issueSession>> | undefined
    await transaction(async (sql) => {
      const account = await verifyFactor(sql, actor, command.proof)
      const change = command.change
      if (change.kind === 'authenticator.replace') {
        await putCeremony(
          sql,
          token,
          enrollment(true),
          actor.user.id,
          account.epoch,
          actor.session.id,
        )
        return
      }
      if (change.kind === 'recovery.regenerate') {
        const factor = await sql.query('SELECT 1 FROM local_factor WHERE user_id=$1', [
          actor.user.id,
        ])
        if (!factor.rowCount) throw new AccessFailure('invalid')
      }
      if (change.kind === 'passkey.remove' && !config.OIDC_DISCOVERY_URL) {
        const alternatives = await sql.query(
          'SELECT 1 FROM local_factor WHERE user_id=$1 UNION ALL SELECT 1 FROM access_passkey WHERE user_id=$1 AND id<>$2',
          [actor.user.id, change.id],
        )
        if (!alternatives.rowCount) throw new AccessFailure('invalid')
      }
      if (change.kind === 'passkey.remove' || change.kind === 'passkey.rename') {
        const result =
          change.kind === 'passkey.remove'
            ? await sql.query('DELETE FROM access_passkey WHERE id=$1 AND user_id=$2', [
                change.id,
                actor.user.id,
              ])
            : await sql.query('UPDATE access_passkey SET name=$3 WHERE id=$1 AND user_id=$2', [
                change.id,
                actor.user.id,
                change.name,
              ])
        if (!result.rowCount) throw new AccessFailure('invalid')
      }
      if (change.kind === 'session.revoke')
        await sql.query('DELETE FROM session WHERE id=$1 AND "userId"=$2', [
          change.id,
          actor.user.id,
        ])
      if (change.kind === 'sessions.revoke-others')
        await sql.query('DELETE FROM session WHERE "userId"=$1 AND id<>$2', [
          actor.user.id,
          actor.session.id,
        ])
      await sql.query('UPDATE account_security SET epoch=epoch+1 WHERE user_id=$1', [actor.user.id])
      if (change.kind === 'session.revoke' && change.id === actor.session.id) return
      rotated = await issueSession(actor.user.id, request)
      if (change.kind === 'recovery.regenerate') {
        await recoveryBatch(sql, actor.user.id)
      }
      await attach(
        sql,
        rotated.session.id,
        actor.user.id,
        account.epoch + 1,
        command.proof.kind === 'totp' ? 'totp' : 'passkey',
        change.kind === 'recovery.regenerate' ? 'save-recovery' : 'ready',
      )
      await sql.query('DELETE FROM session WHERE id=$1', [actor.session.id])
    })
    if (command.change.kind === 'session.revoke' && command.change.id === actor.session.id)
      return respond(request, { stage: await entry() }, { clear: true })
    const headers = new Headers(request.headers)
    if (rotated) headers.set('authorization', `Bearer ${rotated.session.token}`)
    headers.set('x-huddle-client', 'native')
    headers.set('x-huddle-continuation', token)
    return respond(request, await viewFor(new Request(request.url, { headers })), {
      token,
      session: rotated,
    })
  }
  if (command.kind === 'passkey.skip') {
    if (!actor || actor.proof.stage !== 'passkey-offer') throw new AccessFailure('invalid')
    await db.query(
      `UPDATE session_proof SET stage=CASE WHEN a.profile_completed_at IS NULL THEN 'profile' ELSE 'ready' END FROM account_security a WHERE session_id=$1 AND a.user_id=session_proof.user_id AND a.epoch=session_proof.epoch`,
      [actor.session.id],
    )
    return respond(request, await viewFor(request))
  }
  localAllowed()
  if (!oldToken) throw new AccessFailure('expired')
  const snapshot = await loadCeremony(oldToken)
  if (!snapshot) throw new AccessFailure('expired')
  if (snapshot.session_id && snapshot.session_id !== actor?.session.id)
    throw new AccessFailure('reauth_required')
  if ('code' in command) await limit(`factor:${snapshot.user_id ?? snapshot.id_hash}`, 5, 900)
  if (command.kind === 'email.verify' && snapshot.pending.kind === 'email') {
    await limit(`email-verify:${snapshot.pending.email}`, 5, 900)
    await db.query('UPDATE access_ceremony SET attempts=attempts+1 WHERE id_hash=$1', [
      snapshot.id_hash,
    ])
    if (snapshot.pending.codeHash !== digest(`${oldToken}:${command.code}`))
      throw new AccessFailure('invalid')
    const emailPending = snapshot.pending
    await transaction(async (sql) => {
      const userId = await admitEmail(sql, emailPending.email, emailPending.admission)
      const account = await lockAccount(sql, userId)
      const current = await loadCeremony(oldToken, sql, true)
      if (
        !current ||
        current.pending.kind !== 'email' ||
        current.pending.codeHash !== emailPending.codeHash
      )
        throw new AccessFailure('invalid')
      const factor = await sql.query('SELECT user_id FROM local_factor WHERE user_id=$1', [userId])
      const established = await sql.query(
        'SELECT 1 FROM access_passkey WHERE user_id=$1 UNION ALL SELECT 1 FROM account_security WHERE user_id=$1 AND company_established_at IS NOT NULL',
        [userId],
      )
      if (!factor.rowCount && established.rowCount && !current.pending.resetId)
        throw new AccessFailure('reauth_required')
      await sql.query('UPDATE "user" SET "emailVerified"=true WHERE id=$1', [userId])
      await putCeremony(
        sql,
        oldToken,
        current.pending.resetId
          ? enrollment(true, { resetId: current.pending.resetId })
          : factor.rowCount
            ? { kind: 'totp' }
            : enrollment(false),
        userId,
        account.epoch,
      )
    })
    await forgive(`factor:${snapshot.id_hash}`)
    await forgive(`email-verify:${emailPending.email}`)
    return respond(request, await viewFor(request), { token: oldToken })
  }
  if (!snapshot.user_id) throw new AccessFailure('invalid')
  const userId = snapshot.user_id
  let session: Awaited<ReturnType<typeof issueSession>> | undefined
  await transaction(async (sql) => {
    const account = await lockAccount(sql, userId)
    const current = await loadCeremony(oldToken, sql, true)
    if (!current || current.epoch !== account.epoch) throw new AccessFailure('expired')
    const pending = current.pending
    if (command.kind === 'recovery.choose' && pending.kind === 'totp')
      await putCeremony(sql, oldToken, { kind: 'recovery' }, userId, account.epoch)
    else if (command.kind === 'totp.choose' && pending.kind === 'recovery')
      await putCeremony(sql, oldToken, { kind: 'totp' }, userId, account.epoch)
    // A session-bound enrollment is a replacement started from Account security; choosing the
    // current authenticator abandons it.
    else if (command.kind === 'totp.choose' && pending.kind === 'enroll' && current.session_id)
      await sql.query('DELETE FROM access_ceremony WHERE id_hash=$1', [current.id_hash])
    else if (command.kind === 'recovery.verify' && pending.kind === 'recovery') {
      const codeHash = digest(`recovery:${command.code.trim()}`)
      const code = await sql.query(
        'SELECT code_hash FROM recovery_code WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL',
        [userId, codeHash],
      )
      if (!code.rowCount) throw new AccessFailure('invalid')
      await putCeremony(
        sql,
        oldToken,
        enrollment(true, { recoveryHash: codeHash }),
        userId,
        account.epoch,
      )
    } else if (command.kind === 'enrollment.refresh' && pending.kind === 'enroll') {
      await putCeremony(
        sql,
        oldToken,
        enrollment(pending.replacing, {
          recoveryHash: pending.recoveryHash,
          resetId: pending.resetId,
        }),
        userId,
        account.epoch,
        current.session_id,
      )
    } else if (command.kind === 'enrollment.verify' && pending.kind === 'enroll') {
      const delta = totp(pending.secret).validate({ token: command.code, window: 1 })
      if (pending.generation !== command.generation || delta === null)
        throw new AccessFailure('invalid')
      if (!pending.recoveryHash && !pending.resetId && !current.session_id) {
        const established = await sql.query(
          'SELECT 1 FROM local_factor WHERE user_id=$1 UNION ALL SELECT 1 FROM access_passkey WHERE user_id=$1 UNION ALL SELECT 1 FROM account_security WHERE user_id=$1 AND company_established_at IS NOT NULL',
          [userId],
        )
        if (established.rowCount) throw new AccessFailure('reauth_required')
      }
      if (pending.recoveryHash) {
        const used = await sql.query(
          'UPDATE recovery_code SET used_at=now() WHERE code_hash=$1 AND user_id=$2 AND used_at IS NULL RETURNING code_hash',
          [pending.recoveryHash, userId],
        )
        if (!used.rowCount) throw new AccessFailure('invalid')
      }
      if (pending.resetId) {
        const used = await sql.query(
          'UPDATE account_reset SET used_at=now() WHERE id=$1 AND email=(SELECT email FROM "user" WHERE id=$2) AND used_at IS NULL AND expires_at>now() RETURNING id',
          [pending.resetId, userId],
        )
        if (!used.rowCount) throw new AccessFailure('invalid')
        await sql.query('DELETE FROM access_passkey WHERE user_id=$1', [userId])
      }
      await sql.query(
        `INSERT INTO local_factor(user_id,encrypted_secret,last_step) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET encrypted_secret=$2,last_step=$3,enrolled_at=now()`,
        [userId, await seal(pending.secret), Math.floor(Date.now() / 30000) + delta],
      )
      session = await issueSession(userId, request)
      const epoch = account.epoch + 1
      await sql.query('UPDATE account_security SET epoch=$2 WHERE user_id=$1', [userId, epoch])
      await attach(
        sql,
        session.session.id,
        userId,
        epoch,
        pending.recoveryHash ? 'recovery' : 'totp',
        'save-recovery',
      )
      await recoveryBatch(sql, userId)
      await sql.query('DELETE FROM access_ceremony WHERE id_hash=$1', [current.id_hash])
    } else if (command.kind === 'totp.verify' && pending.kind === 'totp') {
      await verifyTotp(sql, userId, command.code)
      session = await issueSession(userId, request)
      await attach(
        sql,
        session.session.id,
        userId,
        account.epoch,
        'totp',
        account.profile_completed_at ? 'ready' : 'profile',
      )
      await sql.query('DELETE FROM access_ceremony WHERE id_hash=$1', [current.id_hash])
    } else throw new AccessFailure('invalid')
  })
  if ('code' in command) await forgive(`factor:${userId}`)
  if (session) {
    const headers = new Headers(request.headers)
    headers.set('authorization', `Bearer ${session.session.token}`)
    return respond(request, await viewFor(new Request(request.url, { headers })), {
      token: oldToken,
      session,
    })
  }
  return respond(request, await viewFor(request), { token: oldToken })
}
export async function accessRequest(request: Request, trustedIp?: string) {
  if (request.method === 'GET') return respond(request, await viewFor(request))
  if (request.method !== 'POST') throw new AccessFailure('invalid')
  const body = await request.text()
  if (body.length > 16000) throw new AccessFailure('invalid')
  const command = AccessCommand.parse(JSON.parse(body))
  if (
    command.kind === 'email.send' ||
    command.kind === 'setup.start' ||
    command.kind === 'reset.redeem' ||
    command.kind === 'reset.request'
  )
    await limit(`send-ip:${trustedIp ?? 'unavailable'}`, 100, 3600)
  if (command.kind === 'setup.start') await limit(`setup-ip:${trustedIp ?? 'unavailable'}`, 10, 900)
  if ('code' in command) await limit(`verify-ip:${trustedIp ?? 'unavailable'}`, 300, 900)
  return advance(request, command)
}
