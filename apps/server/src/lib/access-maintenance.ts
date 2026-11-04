import { db } from './db'

export async function pruneAccess() {
  await db.query(
    `DELETE FROM access_limit WHERE key IN (SELECT key FROM access_limit WHERE starts_at<now()-interval '1 day' LIMIT 1000)`,
  )
  await db.query(`DELETE FROM account_photo WHERE id IN (SELECT p.id FROM account_photo p WHERE p.created_at<now()-interval '1 day'
    AND NOT EXISTS(SELECT 1 FROM account_security a WHERE a.avatar->>'uploadId'=p.id::text)
    AND NOT EXISTS(SELECT 1 FROM message m WHERE m.author_avatar->>'uploadId'=p.id::text)
    AND NOT EXISTS(SELECT 1 FROM direct_message d WHERE d.author_avatar->>'uploadId'=p.id::text) LIMIT 100)`)
  await db.query(
    `DELETE FROM session WHERE id IN (SELECT id FROM session WHERE "expiresAt"<now() LIMIT 1000)`,
  )
}
