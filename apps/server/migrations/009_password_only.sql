DROP TABLE access_ceremony;
DROP TABLE access_device;
DROP TABLE access_passkey;
DROP TABLE local_factor;
DROP TABLE recovery_code;
DROP TABLE account_reset;
DROP TABLE invitation;

DELETE FROM account WHERE "providerId" = 'company';

ALTER TABLE account_security
  DROP COLUMN profile_completed_at,
  DROP COLUMN company_established_at,
  DROP COLUMN company_issuer,
  DROP COLUMN recovery_pending;

DELETE FROM session
WHERE id IN (SELECT session_id FROM session_proof WHERE method <> 'password' OR stage <> 'ready');
ALTER TABLE session_proof
  DROP COLUMN method,
  DROP COLUMN stage,
  DROP COLUMN proved_at;
