import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto'
import { generateId } from 'better-auth'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import {
  defaultMascot,
  formatInvite,
  FriendInvites,
  Password,
  UserId,
  Username,
  type UserId as AccountId,
} from '@huddle/contracts'
import { checkSetupCode, onboard, setupHash } from './admission'
import { AccessFailure, digest, forgive, limit, open, seal, transaction } from './access-store'
import { DomainError, requireMember } from './domain'
import { db } from './db'
import { friendReach } from './reach'

const parameters = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } satisfies ScryptOptions
function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions) {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (error, key) => {
      if (error) reject(error)
      else resolve(key)
    })
  })
}

async function hashPassword(password: string) {
  const salt = randomBytes(16)
  const key = await scrypt(password, salt, 32, parameters)
  return `scrypt$${parameters.N}$${parameters.r}$${parameters.p}$${salt.toString('base64url')}$${key.toString('base64url')}`
}

let dummy: Promise<string> | undefined
function dummyHash() {
  dummy ??= hashPassword('huddle-dummy-password')
  return dummy
}

async function verifyPassword(password: string, stored: string) {
  const [scheme, n, r, p, salt, key] = stored.split('$')
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !key) return false
  const expected = Buffer.from(key, 'base64url')
  let actual: Buffer
  try {
    actual = await scrypt(password, Buffer.from(salt, 'base64url'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: parameters.maxmem,
    })
  } catch {
    return false
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export type Login = { userId: string; passwordHash: string }

async function insertLogin(sql: PoolClient, username: string, password: string): Promise<Login> {
  const id = generateId(32)
  const email = `${id}@member.huddle.invalid`
  const passwordHash = await hashPassword(password)
  try {
    await sql.query(
      'INSERT INTO "user"(id, name, email, "emailVerified") VALUES ($1, $2, $3, true)',
      [id, username, email],
    )
    await sql.query('INSERT INTO account_security(user_id, avatar) VALUES ($1, $2)', [
      id,
      JSON.stringify(defaultMascot(id)),
    ])
    await sql.query('INSERT INTO login(user_id, username, password_hash) VALUES ($1, $2, $3)', [
      id,
      username,
      passwordHash,
    ])
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === '23505')
      throw new DomainError(409, 'That username is taken.')
    throw error
  }
  return { userId: id, passwordHash }
}

async function insertJoinCode(sql: PoolClient) {
  const code = randomBytes(32).toString('base64url')
  await sql.query(
    `INSERT INTO join_code(code_hash, sealed_code) VALUES ($1, $2)
     ON CONFLICT (singleton) DO UPDATE SET code_hash = excluded.code_hash, sealed_code = excluded.sealed_code`,
    [digest(`join:${code}`), await seal(code)],
  )
}

export async function setupAccount(input: {
  code: string
  serverName: string
  username: string
  password: string
}) {
  await checkSetupCode(input.code)
  const username = Username.parse(input.username)
  const password = Password.parse(input.password)
  return transaction(async (sql) => {
    const login = await insertLogin(sql, username, password)
    await onboard(sql, login.userId, input.serverName, setupHash(input.code))
    await insertJoinCode(sql)
    return login
  })
}

export async function joinAccount(input: { code: string; username: string; password: string }) {
  const username = Username.parse(input.username)
  const password = Password.parse(input.password)
  const row = await db.query('SELECT code_hash FROM join_code')
  const stored = z.string().optional().parse(row.rows[0]?.code_hash)
  const actual = Buffer.from(digest(`join:${input.code}`), 'hex')
  const expected = stored ? Buffer.from(stored, 'hex') : actual
  if (!stored || expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw new AccessFailure('invalid')
  return transaction(async (sql) => {
    const login = await insertLogin(sql, username, password)
    await sql.query("INSERT INTO member(user_id, role) VALUES ($1, 'member')", [login.userId])
    return login
  })
}

async function replacePassword(
  sql: PoolClient,
  userId: string,
  passwordHash: string,
  keepSession: string | null = null,
) {
  const row = await sql.query(
    'UPDATE login SET password_hash=$2 WHERE user_id=$1 RETURNING user_id',
    [userId, passwordHash],
  )
  if (!row.rowCount) return false
  await sql.query('DELETE FROM session WHERE "userId"=$1 AND id IS DISTINCT FROM $2', [
    userId,
    keepSession,
  ])
  return true
}

export async function changePassword(
  userId: string,
  sessionId: string,
  current: string,
  next: string,
) {
  await limit(`password-change:${userId}`, 5, 900)
  const passwordHash = await hashPassword(Password.parse(next))
  await transaction(async (sql) => {
    const row = await sql.query('SELECT password_hash FROM login WHERE user_id=$1 FOR UPDATE', [
      userId,
    ])
    const live = await sql.query(
      'SELECT 1 FROM session WHERE id=$1 AND "userId"=$2 AND "expiresAt">now() FOR UPDATE',
      [sessionId, userId],
    )
    if (!live.rowCount) throw new AccessFailure('reauth_required')
    const stored = z.string().parse(row.rows[0]?.password_hash)
    if (!(await verifyPassword(Password.parse(current), stored))) throw new AccessFailure('invalid')
    await replacePassword(sql, userId, passwordHash, sessionId)
  })
  await forgive(`password-change:${userId}`)
}

export async function resetMemberPassword(
  actorId: AccountId,
  targetId: AccountId,
  password: string,
) {
  const next = Password.parse(password)
  const target = UserId.parse(targetId)
  await limit(`member-password:${actorId}`, 10, 900)
  const passwordHash = await hashPassword(next)
  await transaction(async (sql) => {
    await requireMember(sql, actorId, 'admin')
    if (!(await replacePassword(sql, target, passwordHash)))
      throw new DomainError(404, 'That member was not found.')
  })
}

export async function resetPasswordByUsername(username: string, password: string) {
  const name = Username.parse(username)
  const passwordHash = await hashPassword(Password.parse(password))
  return transaction(async (sql) => {
    const row = await sql.query('SELECT user_id FROM login WHERE username=$1 FOR UPDATE', [name])
    const userId = z.string().optional().parse(row.rows[0]?.user_id)
    return userId ? replacePassword(sql, userId, passwordHash) : false
  })
}

export async function signInAccount(username: string, password: string): Promise<Login> {
  const name = Username.parse(username)
  Password.parse(password)
  const row = await db.query('SELECT user_id, password_hash FROM login WHERE username = $1', [name])
  const stored = z.string().optional().parse(row.rows[0]?.password_hash) ?? (await dummyHash())
  const ok = await verifyPassword(password, stored)
  const userId = z.string().optional().parse(row.rows[0]?.user_id)
  if (!userId || !ok) throw new AccessFailure('invalid')
  return { userId, passwordHash: stored }
}

export async function friendInvites(userId: AccountId) {
  await requireMember(db, userId, 'admin')
  const reach = await friendReach()
  if (!reach) return FriendInvites.parse({ invites: [] })
  const row = await db.query('SELECT sealed_code FROM join_code')
  const sealed = z.string().optional().parse(row.rows[0]?.sealed_code)
  if (!sealed) return FriendInvites.parse({ invites: [] })
  const code = await open(sealed, z.string())
  const invites: string[] = []
  const add = (host: string, port: number) => {
    const line = formatInvite({ v: 1, host, port, code, pin: reach.pin })
    if (!invites.includes(line)) invites.push(line)
  }
  for (const host of reach.lan) add(host, reach.port)
  if (reach.external) add(reach.external.address, reach.external.port)
  return FriendInvites.parse({ invites })
}
