ALTER TABLE "user"
  ADD COLUMN tailscale_login text UNIQUE
    CHECK (tailscale_login IS NULL OR length(tailscale_login) BETWEEN 3 AND 320),
  ADD COLUMN legacy_username text;
UPDATE "user" SET legacy_username = login.username FROM login WHERE login.user_id = "user".id;
ALTER TABLE "user"
  DROP COLUMN email,
  DROP COLUMN "emailVerified",
  DROP COLUMN image;

DROP TABLE watch_ticket;
DROP TABLE session;
DROP TABLE account;
DROP TABLE verification;
DROP TABLE login;

DROP TABLE join_code;
CREATE TABLE join_code (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9_-]{20,128}$')
);
INSERT INTO join_code(code)
SELECT replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
FROM server;

DELETE FROM setup_code;
DELETE FROM access_limit;
