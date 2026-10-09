import { db } from './db'

export async function pruneAccess() {
  await db.query(
    `DELETE FROM access_ceremony WHERE id_hash IN (SELECT id_hash FROM access_ceremony WHERE expires_at<now() LIMIT 1000)`,
  )
  await db.query(
    `DELETE FROM access_device WHERE device_hash IN (SELECT device_hash FROM access_device WHERE expires_at<now() LIMIT 1000)`,
  )
  await db.query(
    `DELETE FROM access_limit WHERE key IN (SELECT key FROM access_limit WHERE starts_at<now()-interval '1 day' LIMIT 1000)`,
  )
  await db.query(`DELETE FROM account_photo WHERE id IN (SELECT p.id FROM account_photo p WHERE p.created_at<now()-interval '1 day'
    AND NOT EXISTS(SELECT 1 FROM account_security a WHERE a.avatar->>'uploadId'=p.id::text)
    AND NOT EXISTS(SELECT 1 FROM message m WHERE m.author_avatar->>'uploadId'=p.id::text) LIMIT 100)`)
  await db.query(
    `DELETE FROM account_reset WHERE id IN (SELECT id FROM account_reset WHERE requested_at<now()-interval '90 days' LIMIT 1000)`,
  )
  await db.query(`DELETE FROM session WHERE id IN (SELECT s.id FROM session s LEFT JOIN session_proof p ON p.session_id=s.id
    WHERE s."expiresAt"<now() OR (p.session_id IS NULL AND s."createdAt"<now()-interval '1 day') LIMIT 1000)`)
}
