import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import {
  defaultMascot,
  formatInvite,
  MemberRole,
  ServerInvite,
  TailscaleLogin,
  UserId,
} from '@huddle/contracts'
import { checkSetupCode, onboard, setupHash } from './admission'
import { AccessFailure, digest, transaction } from './access-store'
import { config } from './config'
import { db } from './db'
import { lockServer, requireMember } from './domain'

async function insertAccountUnlessLoginTaken(sql: PoolClient, login: TailscaleLogin, name: string) {
  const id = randomUUID()
  const inserted = await sql.query(
    'INSERT INTO "user"(id, name, tailscale_login) VALUES ($1, $2, $3) ON CONFLICT (tailscale_login) DO NOTHING',
    [id, name, login],
  )
  if (!inserted.rowCount) return null
  await sql.query('INSERT INTO account_security(user_id, avatar) VALUES ($1, $2)', [
    id,
    JSON.stringify(defaultMascot(id)),
  ])
  return id
}

export async function setupAccount(
  login: TailscaleLogin,
  input: { code: string; serverName: string; name: string },
) {
  await checkSetupCode(input.code)
  await transaction(async (sql) => {
    const id = await insertAccountUnlessLoginTaken(sql, login, input.name)
    if (!id) throw new AccessFailure('expired')
    await onboard(sql, id, input.serverName, setupHash(input.code))
    await sql.query('INSERT INTO join_code(code) VALUES ($1)', [
      randomBytes(32).toString('base64url'),
    ])
  })
}

export async function joinAccount(login: TailscaleLogin, input: { code: string; name: string }) {
  const row = await db.query('SELECT code FROM join_code')
  const stored = z.string().optional().parse(row.rows[0]?.code)
  const same =
    stored !== undefined &&
    timingSafeEqual(Buffer.from(digest(stored)), Buffer.from(digest(input.code)))
  if (!same) throw new AccessFailure('invalid')
  await transaction(async (sql) => {
    await lockServer(sql)
    await insertAccountUnlessLoginTaken(sql, login, input.name)
    await sql.query(
      `INSERT INTO member(user_id, role) SELECT u.id, 'member' FROM "user" u
      WHERE u.tailscale_login = $1 AND NOT EXISTS (SELECT 1 FROM blocked_account b WHERE b.user_id = u.id)
      ON CONFLICT (user_id) DO NOTHING`,
      [login],
    )
  })
}

const AccountRow = z.object({
  id: UserId,
  name: z.string(),
  role: MemberRole,
  legacyUsername: z.string().nullable(),
  joinedAt: z.date(),
  login: TailscaleLogin.nullable(),
})
export type AccountRow = z.infer<typeof AccountRow>

export async function listAccounts(): Promise<AccountRow[]> {
  const { rows } = await db.query(
    `SELECT u.id, u.name, m.role, u.legacy_username AS "legacyUsername", m.created_at AS "joinedAt",
      u.tailscale_login AS login
    FROM member m JOIN "user" u ON u.id = m.user_id
    ORDER BY m.role = 'admin' DESC, m.created_at, u.id`,
  )
  return AccountRow.array().parse(rows)
}

export type LoginMove =
  | { moved: false }
  | {
      moved: true
      account: UserId
      name: string
      previous: string | null
      from: { id: UserId; name: string } | null
    }

export async function moveLogin(target: string, login: TailscaleLogin): Promise<LoginMove> {
  return transaction(async (sql) => {
    const found = await sql.query(
      `SELECT u.id, u.name, u.tailscale_login AS previous FROM "user" u
      JOIN member m ON m.user_id = u.id
      WHERE u.id = $1 OR u.legacy_username = $1
      FOR UPDATE OF u`,
      [target],
    )
    const account = found.rows[0]
    if (found.rowCount !== 1 || !account) return { moved: false }
    const id = UserId.parse(account.id)
    const taken = await sql.query(
      `UPDATE "user" SET tailscale_login = NULL, "updatedAt" = now()
      WHERE tailscale_login = $1 AND id <> $2 RETURNING id, name`,
      [login, id],
    )
    await sql.query(`UPDATE "user" SET tailscale_login = $2, "updatedAt" = now() WHERE id = $1`, [
      id,
      login,
    ])
    return {
      moved: true,
      account: id,
      name: z.string().parse(account.name),
      previous: z.string().nullable().parse(account.previous),
      from: taken.rows[0]
        ? { id: UserId.parse(taken.rows[0].id), name: z.string().parse(taken.rows[0].name) }
        : null,
    }
  })
}

export async function serverInvite(actor: UserId) {
  await requireMember(db, actor, 'admin')
  const row = await db.query('SELECT code FROM join_code')
  return ServerInvite.parse({
    invite: formatInvite({
      origin: config.SERVER_URL,
      code: z.string().parse(row.rows[0]?.code),
    }),
  })
}
