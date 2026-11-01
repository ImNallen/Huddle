import { randomInt } from 'node:crypto'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { config } from './config'
import { db } from './db'
import { AccessFailure, digest } from './access-store'

type Sql = Pick<PoolClient, 'query'>

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
    `\nHuddle setup: this server is not set up yet.\nOpen ${config.SERVER_URL}/login and enter the server name, a username, a password, and ${shown}\nThe code works once and expires in 24 hours. Restarting the server replaces it until setup is complete.\n\n`,
  )
}
export async function checkSetupCode(code: string) {
  const result = await db.query(
    'SELECT 1 FROM setup_code WHERE code_hash = $1 AND expires_at > now() AND NOT EXISTS (SELECT 1 FROM server)',
    [setupHash(code)],
  )
  if (!result.rowCount) throw new AccessFailure('invalid')
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
