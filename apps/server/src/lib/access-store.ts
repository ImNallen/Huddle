import { createHmac } from 'node:crypto'
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto'
import type { PoolClient } from 'pg'
import { z } from 'zod'
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
export async function forgive(key: string) {
  await db.query('UPDATE access_limit SET count=greatest(0,count-1) WHERE key=$1', [digest(key)])
}
