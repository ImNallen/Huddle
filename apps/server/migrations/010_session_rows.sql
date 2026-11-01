DELETE FROM session s
WHERE NOT EXISTS (
  SELECT 1 FROM session_proof p
  JOIN account_security a ON a.user_id = p.user_id AND a.epoch = p.epoch
  WHERE p.session_id = s.id AND p.user_id = s."userId"
);
DROP TABLE session_proof;
ALTER TABLE account_security DROP COLUMN epoch;
