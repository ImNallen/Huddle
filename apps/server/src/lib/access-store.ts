import { createHmac, randomBytes } from 'node:crypto'
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { Avatar } from '@huddle/contracts'
import { config } from './config'
import { db } from './db'

export class AccessFailure extends Error {
  constructor(
    public code: 'invalid' | 'expired' | 'rate_limited' | 'unavailable' | 'reauth_required',
    public retryAt?: string,
  ) {
    super(code)
  }
}
export const opaque = () => randomBytes(32).toString('base64url')
export const digest = (value: string) =>
  createHmac('sha256', config.BETTER_AUTH_SECRET).update(value).digest('hex')
const encryptionKeys = config.AUTH_ENCRYPTION_KEYS ?? [
  { version: 1, secret: config.BETTER_AUTH_SECRET },
]
const primaryKey = encryptionKeys[0]
if (!primaryKey || new Set(encryptionKeys.map((key) => key.version)).size !== encryptionKeys.length)
  throw new Error('Encryption key versions must be unique')
const encryption = {
  currentVersion: primaryKey.version,
  keys: new Map(encryptionKeys.map((key) => [key.version, key.secret])),
  legacySecret: config.BETTER_AUTH_SECRET,
}
export const seal = (data: unknown) =>
  symmetricEncrypt({ key: encryption, data: JSON.stringify(data) })
export async function open<T>(value: string, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(JSON.parse(await symmetricDecrypt({ key: encryption, data: value })))
}
export async function transaction<T>(fn: (sql: PoolClient) => Promise<T>): Promise<T> {
  const sql = await db.connect()
  try {
    await sql.query('BEGIN')
    const result = await fn(sql)
    await sql.query('COMMIT')
    return result
  } catch (error) {
    await sql.query('ROLLBACK')
    throw error
  } finally {
    sql.release()
  }
}
export const Account = z.object({
  user_id: z.string(),
  epoch: z.number(),
  profile_completed_at: z.date().nullable(),
  recovery_pending: z.string().nullable(),
  avatar: Avatar,
})
export async function lockAccount(sql: PoolClient, userId: string) {
  await sql.query('INSERT INTO account_security(user_id) VALUES ($1) ON CONFLICT DO NOTHING', [
    userId,
  ])
  const result = await sql.query('SELECT * FROM account_security WHERE user_id=$1 FOR UPDATE', [
    userId,
  ])
  return Account.parse(result.rows[0])
}
export async function limit(key: string, maximum: number, seconds: number): Promise<void> {
  const result = await db.query(
    `INSERT INTO access_limit(key) VALUES ($1)
    ON CONFLICT(key) DO UPDATE SET count=CASE WHEN access_limit.starts_at < now()-($2 * interval '1 second') THEN 1 ELSE access_limit.count+1 END,
    starts_at=CASE WHEN access_limit.starts_at < now()-($2 * interval '1 second') THEN now() ELSE access_limit.starts_at END
    RETURNING count, starts_at`,
    [digest(key), seconds],
  )
  const row = z.object({ count: z.number(), starts_at: z.date() }).parse(result.rows[0])
  if (row.count > maximum)
    throw new AccessFailure(
      'rate_limited',
      new Date(row.starts_at.getTime() + seconds * 1000).toISOString(),
    )
}
export const Pending = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('company-passkey') }),
  z.object({
    kind: z.literal('company-session'),
    change: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('session.revoke'), id: z.string().min(1).max(512) }).strict(),
      z.object({ kind: z.literal('sessions.revoke-others') }).strict(),
    ]),
  }),
  z.object({
    kind: z.literal('email'),
    email: z.email(),
    codeHash: z.string(),
    resendAt: z.string(),
    resetId: z.string().optional(),
  }),
  z.object({ kind: z.literal('totp') }),
  z.object({ kind: z.literal('recovery') }),
  z.object({
    kind: z.literal('enroll'),
    secret: z.string(),
    generation: z.string(),
    replacing: z.boolean(),
    recoveryHash: z.string().optional(),
    resetId: z.string().optional(),
  }),
  z.object({ kind: z.literal('save-recovery'), batch: z.string(), codes: z.array(z.string()) }),
  z.object({
    kind: z.literal('passkey'),
    challenge: z.string(),
    purpose: z.enum(['signin', 'reauth', 'register']),
    name: z.string().optional(),
  }),
  z.object({ kind: z.literal('factor-proof'), sessionId: z.string() }),
])
export type Pending = z.infer<typeof Pending>
export const Ceremony = z.object({
  id_hash: z.string(),
  user_id: z.string().nullable(),
  session_id: z.string().nullable(),
  epoch: z.number().nullable(),
  encrypted_payload: z.string(),
  expires_at: z.date(),
  attempts: z.number(),
})
export async function loadCeremony(
  token: string | null,
  sql: Pick<PoolClient, 'query'> = db,
  lock = false,
) {
  if (!token) return null
  const result = await sql.query(
    `SELECT * FROM access_ceremony WHERE id_hash=$1 ${lock ? 'FOR UPDATE' : ''}`,
    [digest(token)],
  )
  if (!result.rows[0]) return null
  const row = Ceremony.parse(result.rows[0])
  if (row.expires_at.getTime() <= Date.now() || row.attempts > 5) throw new AccessFailure('expired')
  return { ...row, pending: await open(row.encrypted_payload, Pending) }
}
export async function putCeremony(
  sql: Pick<PoolClient, 'query'>,
  token: string,
  pending: Pending,
  userId: string | null,
  epoch: number | null,
  sessionId: string | null = null,
  seconds = 900,
) {
  await sql.query(
    `INSERT INTO access_ceremony(id_hash,user_id,epoch,session_id,encrypted_payload,expires_at)
    VALUES($1,$2,$3,$4,$5,now()+($6 * interval '1 second')) ON CONFLICT(id_hash) DO UPDATE SET user_id=$2,epoch=$3,session_id=$4,encrypted_payload=$5,expires_at=now()+($6 * interval '1 second'),attempts=0`,
    [digest(token), userId, epoch, sessionId, await seal(pending), seconds],
  )
}

export async function forgive(key: string) {
  await db.query('UPDATE access_limit SET count=greatest(0,count-1) WHERE key=$1', [digest(key)])
}
