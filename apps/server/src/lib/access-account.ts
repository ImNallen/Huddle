import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { AccountSecurity } from '@huddle/contracts'
import { z } from 'zod'
import { requireAccess } from './access'
import { db } from './db'
import { AccessFailure, limit } from './access-store'

export async function accountRequest(request: Request) {
  const actor = await requireAccess(request.headers)
  const path = new URL(request.url).pathname
  if (path.startsWith('/api/account/photo/')) {
    const id = z.uuid().parse(path.slice('/api/account/photo/'.length))
    const result = await db.query(
      `SELECT p.bytes FROM account_photo p WHERE p.id=$1 AND (p.user_id=$2 OR EXISTS(
      SELECT 1 FROM member mine, member theirs WHERE mine.user_id=$2 AND theirs.user_id=p.user_id))`,
      [id, actor.user.id],
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
  if (path !== '/api/account' || request.method !== 'GET')
    throw new AccessFailure('reauth_required')
  const sessions = await db.query(
    'SELECT id,"createdAt","expiresAt","userAgent" FROM session WHERE "userId"=$1 AND "expiresAt">now() ORDER BY "createdAt",id',
    [actor.user.id],
  )
  const date = (value: unknown) => z.date().parse(value).toISOString()
  return Response.json(
    AccountSecurity.parse({
      user: actor.user,
      sessions: sessions.rows.map((row) => ({
        id: row.id,
        current: row.id === actor.session.id,
        createdAt: date(row.createdAt),
        expiresAt: date(row.expiresAt),
        userAgent: row.userAgent,
      })),
    }),
  )
}
