import { randomInt } from 'node:crypto'
import { generateId } from 'better-auth'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { Invitation, PendingInvitations, type UserId } from '@huddle/contracts'
import { config } from './config'
import { db } from './db'
import { createEmailSender } from './email'
import { emailRecipient } from './email-config'
import { AccessFailure, digest, type Pending } from './access-store'
import { DomainError, requireMember, transaction } from './domain'

type Sql = Pick<PoolClient, 'query'>
export const sendEmail = createEmailSender(config.EMAIL, config.SERVER_URL)
export type Admission = Extract<Pending, { kind: 'email' }>['admission']

const setupAlphabet = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'
export const setupHash = (code: string) =>
  digest(`setup:${code.toUpperCase().replace(/[\s-]/g, '')}`)

export async function serverName(sql: Sql = db) {
  const result = await sql.query('SELECT name FROM server')
  return z.string().optional().parse(result.rows[0]?.name) ?? 'Huddle'
}
export async function setupRequired() {
  return !(await db.query('SELECT 1 FROM server')).rowCount
}
export async function prepareSetup() {
  await db.query('DELETE FROM setup_code WHERE EXISTS (SELECT 1 FROM server)')
  const code =
    config.SETUP_CODE ??
    Array.from({ length: 4 }, () =>
      Array.from({ length: 4 }, () => setupAlphabet[randomInt(setupAlphabet.length)]).join(''),
    ).join('-')
  const stored = await db.query(
    `INSERT INTO setup_code(code_hash, expires_at) SELECT $1, now() + interval '24 hours'
    WHERE NOT EXISTS (SELECT 1 FROM server)
    ON CONFLICT (singleton) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at`,
    [setupHash(code)],
  )
  if (!stored.rowCount) return
  const shown = config.SETUP_CODE ? 'the code from SETUP_CODE' : `this setup code:\n\n    ${code}\n`
  process.stdout.write(
    `\nHuddle setup: this server is not set up yet.\nOpen ${config.SERVER_URL}/login and enter the server name, the admin's email, and ${shown}\nThe code works once and expires in 24 hours. Restarting the server replaces it until setup is complete.\n\n`,
  )
}
export async function checkSetupCode(code: string) {
  const result = await db.query(
    'SELECT 1 FROM setup_code WHERE code_hash = $1 AND expires_at > now() AND NOT EXISTS (SELECT 1 FROM server)',
    [setupHash(code)],
  )
  if (!result.rowCount) throw new AccessFailure('invalid')
}
export async function mayReceiveCode(email: string) {
  const result = await db.query(
    'SELECT 1 FROM "user" WHERE email = $1 UNION ALL SELECT 1 FROM invitation WHERE email = $1 AND accepted_at IS NULL AND expires_at > now()',
    [email],
  )
  return Boolean(result.rowCount)
}
async function createUser(sql: Sql, email: string) {
  await sql.query(
    'INSERT INTO "user"(id, name, email, "emailVerified") VALUES ($1, $2, $3, true) ON CONFLICT (email) DO NOTHING',
    [generateId(32), email.split('@')[0] || 'Member', email],
  )
  const result = await sql.query('SELECT id FROM "user" WHERE email = $1', [email])
  return z.string().parse(result.rows[0]?.id)
}
export async function acceptInvitation(sql: Sql, userId: string, email: string) {
  if ((await sql.query('SELECT 1 FROM member WHERE user_id = $1', [userId])).rowCount) return
  const accepted = await sql.query(
    'UPDATE invitation SET accepted_by = $1, accepted_at = now() WHERE email = $2 AND accepted_at IS NULL AND expires_at > now() RETURNING email',
    [userId, email],
  )
  if (accepted.rowCount)
    await sql.query("INSERT INTO member(user_id, role) VALUES ($1, 'member')", [userId])
}
export async function onboard(sql: Sql, userId: string, serverName: string, setupHash: string) {
  const setup = await sql.query(
    'DELETE FROM setup_code WHERE code_hash = $1 AND expires_at > now() RETURNING code_hash',
    [setupHash],
  )
  if (!setup.rowCount) throw new AccessFailure('expired')
  await sql.query('INSERT INTO server(name) VALUES ($1)', [serverName])
  await sql.query("INSERT INTO member(user_id, role) VALUES ($1, 'admin')", [userId])
}
export async function admitEmail(sql: Sql, email: string, admission: Admission) {
  const existing = await sql.query('SELECT id FROM "user" WHERE email = $1', [email])
  const known = z.string().optional().parse(existing.rows[0]?.id)
  if (admission.kind === 'setup') {
    const userId = known ?? (await createUser(sql, email))
    await onboard(sql, userId, admission.serverName, admission.setupHash)
    return userId
  }
  if (known) {
    await acceptInvitation(sql, known, email)
    return known
  }
  const invited = await sql.query(
    'SELECT 1 FROM invitation WHERE email = $1 AND accepted_at IS NULL AND expires_at > now() FOR UPDATE',
    [email],
  )
  if (!invited.rowCount) throw new AccessFailure('invalid')
  const userId = await createUser(sql, email)
  await acceptInvitation(sql, userId, email)
  return userId
}
export async function invite(user: { id: UserId; name: string }, address: string) {
  const email = address.toLowerCase()
  const { invitation, name } = await transaction(async (sql) => {
    await requireMember(sql, user.id, 'admin')
    const member = await sql.query(
      'SELECT 1 FROM "user" u JOIN member m ON m.user_id = u.id WHERE u.email = $1',
      [email],
    )
    if (member.rowCount) throw new DomainError(409, `${email} is already a member of this server.`)
    const result = await sql.query(
      `INSERT INTO invitation(email, invited_by, expires_at) VALUES ($1, $2, now() + interval '7 days')
      ON CONFLICT (email) DO UPDATE SET invited_by = $2, expires_at = excluded.expires_at, accepted_by = NULL, accepted_at = NULL
      RETURNING email, to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "expiresAt"`,
      [email, user.id],
    )
    return { invitation: Invitation.parse(result.rows[0]), name: await serverName(sql) }
  })
  try {
    await sendEmail({
      kind: 'invitation',
      recipient: emailRecipient(email),
      serverName: name,
      inviter: user.name,
      expiresAt: invitation.expiresAt,
    })
  } catch {
    throw new DomainError(
      503,
      'The invitation is saved, but the email could not be sent. Try again in a moment.',
    )
  }
  return invitation
}
export async function pendingInvitations(userId: UserId) {
  return transaction(async (sql) => {
    await requireMember(sql, userId, 'admin')
    const result = await sql.query(
      `SELECT i.email, to_char(i.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "expiresAt", u.name AS "invitedBy"
      FROM invitation i JOIN "user" u ON u.id = i.invited_by
      WHERE i.accepted_at IS NULL ORDER BY i.expires_at, i.email`,
    )
    return PendingInvitations.parse({ invitations: result.rows })
  }, true)
}
export async function revokeInvitation(userId: UserId, address: string) {
  const email = address.toLowerCase()
  await transaction(async (sql) => {
    await requireMember(sql, userId, 'admin')
    const revoked = await sql.query(
      'DELETE FROM invitation WHERE email = $1 AND accepted_at IS NULL RETURNING email',
      [email],
    )
    if (!revoked.rowCount)
      throw new DomainError(404, `There is no pending invitation for ${email}.`)
  })
}
