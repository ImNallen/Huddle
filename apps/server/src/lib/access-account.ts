import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { AccountSecurity } from '@huddle/contracts'
import { z } from 'zod'
import { requireAccess } from './access'
import { config } from './config'
import { db } from './db'
import { AccessFailure, limit } from './access-store'

export async function accountRequest(request: Request) {
  const actor = await requireAccess(request.headers, 'account')
  const path = new URL(request.url).pathname
  if (path.startsWith('/api/account/photo/')) {
    const id = z.uuid().parse(path.slice('/api/account/photo/'.length))
    const result = await db.query(
      `SELECT p.bytes FROM account_photo p WHERE p.id=$1 AND (p.user_id=$2 OR ($3 AND EXISTS(
      SELECT 1 FROM membership mine JOIN membership theirs ON mine.workspace_id=theirs.workspace_id WHERE mine.user_id=$2 AND theirs.user_id=p.user_id)))`,
      [id, actor.user.id, actor.proof.stage === 'ready'],
    )
    if (!result.rows[0]) throw new AccessFailure('invalid')
    const bytes = z.instanceof(Buffer).parse(result.rows[0].bytes)
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': 'image/webp',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  }
  if (path === '/api/account/photo' && request.method === 'POST') {
    await limit(`photo:${actor.user.id}`, 10, 3600)
    const bytes = await request.arrayBuffer()
    if (bytes.byteLength > 5 * 1024 * 1024 + 8192) throw new AccessFailure('invalid')
    const form = await new Request(request.url, {
      method: 'POST',
      headers: request.headers,
      body: bytes,
    })
      .formData()
      .catch(() => {
        throw new AccessFailure('invalid')
      })
    const photo = form.get('photo')
    if (!(photo instanceof File) || photo.size > 5 * 1024 * 1024) throw new AccessFailure('invalid')
    const input = Buffer.from(await photo.arrayBuffer())
    const decoder = sharp(input, { limitInputPixels: 4096 * 4096, animated: false })
    const metadata = await decoder.metadata().catch(() => {
      throw new AccessFailure('invalid')
    })
    if (
      !metadata.width ||
      !metadata.height ||
      metadata.width > 4096 ||
      metadata.height > 4096 ||
      !['png', 'jpeg', 'webp'].includes(metadata.format)
    )
      throw new AccessFailure('invalid')
    const image = await decoder
      .rotate()
      .resize(512, 512, { fit: 'cover', withoutEnlargement: true })
      .webp()
      .toBuffer()
      .catch(() => {
        throw new AccessFailure('invalid')
      })
    const uploadId = randomUUID()
    await db.query('INSERT INTO account_photo(id,user_id,bytes) VALUES($1,$2,$3)', [
      uploadId,
      actor.user.id,
      image,
    ])
    return Response.json({ uploadId })
  }
  if (path !== '/api/account' || request.method !== 'GET' || actor.proof.stage !== 'ready')
    throw new AccessFailure('reauth_required')
  const [factor, recovery, passkeys, sessions] = await Promise.all([
    db.query('SELECT enrolled_at FROM local_factor WHERE user_id=$1', [actor.user.id]),
    db.query(
      'SELECT count(*)::integer total,count(*) FILTER(WHERE used_at IS NULL)::integer remaining,min(created_at) created FROM recovery_code WHERE user_id=$1',
      [actor.user.id],
    ),
    db.query(
      'SELECT id,name,created_at,last_used_at FROM access_passkey WHERE user_id=$1 ORDER BY created_at',
      [actor.user.id],
    ),
    db.query(
      'SELECT s.id,s."createdAt",s."expiresAt",s."userAgent",p.method FROM session s JOIN session_proof p ON p.session_id=s.id WHERE p.user_id=$1 AND p.epoch=$2 AND s."expiresAt">now()',
      [actor.user.id, actor.proof.epoch],
    ),
  ])
  const date = (value: unknown) => z.date().parse(value).toISOString()
  return Response.json(
    AccountSecurity.parse({
      user: actor.user,
      policy: config.AUTH_POLICY,
      authenticator: factor.rows[0] ? { enrolledAt: date(factor.rows[0].enrolled_at) } : null,
      recoveryCreatedAt: recovery.rows[0].created ? date(recovery.rows[0].created) : null,
      recoveryTotal: recovery.rows[0].total,
      recoveryRemaining: recovery.rows[0].remaining,
      passkeys: passkeys.rows.map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: date(row.created_at),
        lastUsedAt: row.last_used_at ? date(row.last_used_at) : null,
      })),
      sessions: sessions.rows.map((row) => ({
        id: row.id,
        current: row.id === actor.session.id,
        method: row.method,
        createdAt: date(row.createdAt),
        expiresAt: date(row.expiresAt),
        userAgent: row.userAgent,
      })),
    }),
  )
}
