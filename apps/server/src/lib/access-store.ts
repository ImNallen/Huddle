import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import type { AccessError } from '@huddle/contracts'
import { db } from './db'

export class AccessFailure extends Error {
  constructor(
    public code: AccessError['error'],
    public retryAt?: string,
  ) {
    super(code)
  }
}
export const digest = (value: string) => createHash('sha256').update(value).digest('hex')
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
