import { randomInt } from 'node:crypto'
import { z } from 'zod'
import { config } from './config'
import { db } from './db'
import { attach, issueSession, requireAccess } from './access'
import { AccessFailure, digest, limit, lockAccount, opaque, transaction } from './access-store'

const Client = z.literal('huddle-desktop')
export async function decideDevice(
  request: Request,
  userCode: string,
  decision: 'approve' | 'deny',
) {
  const actor = await requireAccess(request.headers)
  await transaction(async (sql) => {
    const account = await lockAccount(sql, actor.user.id)
    if (account.epoch !== actor.proof.epoch) throw new AccessFailure('reauth_required')
    const changed = await sql.query(
      `UPDATE access_device SET status=$2,session_id=$3,epoch=$4
      WHERE user_code=$1 AND status='pending' AND expires_at>now() AND (session_id IS NULL OR session_id=$3)`,
      [
        userCode.toUpperCase(),
        decision === 'approve' ? 'approved' : 'denied',
        actor.session.id,
        account.epoch,
      ],
    )
    if (!changed.rowCount) throw new AccessFailure('expired')
  })
}
export async function deviceRequest(request: Request, trustedIp?: string) {
  const path = new URL(request.url).pathname
  if (request.method === 'GET' && path === '/api/auth/device') {
    const actor = await requireAccess(request.headers)
    const code = new URL(request.url).searchParams.get('user_code')?.toUpperCase()
    await db.query(
      "UPDATE access_device SET session_id=$2 WHERE user_code=$1 AND status='pending' AND session_id IS NULL AND expires_at>now()",
      [code, actor.session.id],
    )
    const result = await db.query(
      `SELECT user_code,status,expires_at - interval '10 minutes' AS requested_at FROM access_device
      WHERE user_code=$1 AND expires_at>now() AND status<>'consumed'`,
      [code],
    )
    if (!result.rows[0]) throw new AccessFailure('expired')
    return Response.json({ ...result.rows[0], client_id: 'huddle-desktop' })
  }
  if (request.method !== 'POST') throw new AccessFailure('invalid')
  const raw: unknown = await request.json()
  if (path === '/api/auth/device/code') {
    z.object({ client_id: Client }).strict().parse(raw)
    await limit(`device-code:${trustedIp ?? 'unavailable'}`, 100, 60)
    const token = opaque()
    const userCode = Array.from(
      { length: 8 },
      () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[randomInt(32)],
    ).join('')
    await db.query('INSERT INTO access_device(device_hash,user_code) VALUES($1,$2)', [
      digest(token),
      userCode,
    ])
    return Response.json({
      device_code: token,
      user_code: userCode,
      verification_uri: `${config.SERVER_URL}/device`,
      verification_uri_complete: `${config.SERVER_URL}/device?user_code=${userCode}`,
      expires_in: 600,
      interval: 5,
    })
  }
  if (path === '/api/auth/device/cancel') {
    const body = z.object({ device_code: z.string(), client_id: Client }).strict().parse(raw)
    await db.query("UPDATE access_device SET status='consumed' WHERE device_hash=$1", [
      digest(body.device_code),
    ])
    return Response.json({ success: true })
  }
  if (path === '/api/auth/device/approve' || path === '/api/auth/device/deny') {
    const body = z
      .union([
        z.object({ user_code: z.string() }).strict(),
        z.object({ userCode: z.string() }).strict(),
      ])
      .parse(raw)
    await decideDevice(
      request,
      'user_code' in body ? body.user_code : body.userCode,
      path === '/api/auth/device/approve' ? 'approve' : 'deny',
    )
    return Response.json({ success: true })
  }
  if (path !== '/api/auth/device/token') throw new AccessFailure('invalid')
  const body = z
    .object({
      device_code: z.string(),
      client_id: Client,
      grant_type: z.literal('urn:ietf:params:oauth:grant-type:device_code'),
    })
    .strict()
    .parse(raw)
  const result = await transaction(async (sql) => {
    const lookup = await sql.query(
      `SELECT d.*,p.user_id,p.method,p.proved_at FROM access_device d LEFT JOIN session_proof p ON p.session_id=d.session_id WHERE device_hash=$1`,
      [digest(body.device_code)],
    )
    if (!lookup.rows[0]) return { error: 'expired_token' }
    const device = z
      .object({
        status: z.string(),
        expires_at: z.date(),
        user_id: z.string().nullable(),
        session_id: z.string().nullable(),
        epoch: z.number().nullable(),
        last_poll_at: z.date().nullable(),
      })
      .parse(lookup.rows[0])
    if (device.expires_at.getTime() <= Date.now() || device.status === 'consumed')
      return { error: 'expired_token' }
    if (device.status === 'denied') return { error: 'access_denied' }
    if (device.status === 'pending') {
      const update = await sql.query(
        `UPDATE access_device SET last_poll_at=now() WHERE device_hash=$1 AND (last_poll_at IS NULL OR last_poll_at<now()-interval '5 seconds')`,
        [digest(body.device_code)],
      )
      return { error: update.rowCount ? 'authorization_pending' : 'slow_down' }
    }
    if (!device.user_id || !device.session_id) return { error: 'expired_token' }
    const account = await lockAccount(sql, device.user_id)
    const current = await sql.query(
      `SELECT p.method,p.proved_at FROM access_device d JOIN session_proof p ON p.session_id=d.session_id JOIN session s ON s.id=p.session_id
      WHERE d.device_hash=$1 AND d.status='approved' AND d.expires_at>now() AND d.epoch=$2 AND p.epoch=$2 AND p.stage='ready' AND s."expiresAt">now() FOR UPDATE OF d`,
      [digest(body.device_code), account.epoch],
    )
    if (!current.rows[0]) return { error: 'expired_token' }
    const proof = z
      .object({ method: z.enum(['totp', 'recovery', 'passkey', 'company']), proved_at: z.date() })
      .parse(current.rows[0])
    if (config.AUTH_POLICY === 'sso-only' && proof.method !== 'company')
      return { error: 'access_denied' }
    const session = await issueSession(device.user_id, request)
    await attach(sql, session.session.id, device.user_id, account.epoch, proof.method, 'ready')
    await sql.query('UPDATE session_proof SET proved_at=$2 WHERE session_id=$1', [
      session.session.id,
      proof.proved_at,
    ])
    await sql.query("UPDATE access_device SET status='consumed' WHERE device_hash=$1", [
      digest(body.device_code),
    ])
    return {
      access_token: session.session.token,
      token_type: 'Bearer',
      expires_in: Math.floor((session.session.expiresAt.getTime() - Date.now()) / 1000),
    }
  })
  return Response.json(result, { status: 'error' in result ? 400 : 200 })
}
