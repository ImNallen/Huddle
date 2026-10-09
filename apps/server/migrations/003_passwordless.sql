UPDATE account SET password = NULL WHERE "providerId" = 'credential';
CREATE TABLE account_security (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  epoch integer NOT NULL DEFAULT 1,
  profile_completed_at timestamptz,
  company_established_at timestamptz,
  avatar jsonb NOT NULL DEFAULT '{"kind":"mascot","shape":"circle","color":"indigo"}'
);
INSERT INTO account_security(user_id) SELECT id FROM "user";
CREATE TABLE local_factor (
  user_id text PRIMARY KEY REFERENCES account_security(user_id) ON DELETE CASCADE,
  encrypted_secret text NOT NULL,
  last_step bigint NOT NULL,
  enrolled_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE session_proof (
  session_id text PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES account_security(user_id) ON DELETE CASCADE,
  epoch integer NOT NULL,
  method text NOT NULL CHECK (method IN ('totp','recovery','passkey','company')),
  proved_at timestamptz NOT NULL DEFAULT now(),
  stage text NOT NULL CHECK (stage IN ('save-recovery','passkey-offer','profile','ready'))
);
CREATE TABLE access_ceremony (
  id_hash text PRIMARY KEY,
  user_id text REFERENCES account_security(user_id) ON DELETE CASCADE,
  session_id text REFERENCES session(id) ON DELETE CASCADE,
  epoch integer,
  encrypted_payload text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0
);
CREATE INDEX access_ceremony_expiry ON access_ceremony(expires_at);
CREATE TABLE recovery_code (
  user_id text NOT NULL REFERENCES account_security(user_id) ON DELETE CASCADE,
  batch uuid NOT NULL,
  code_hash text PRIMARY KEY,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE access_limit (
  key text PRIMARY KEY,
  starts_at timestamptz NOT NULL DEFAULT now(),
  count integer NOT NULL DEFAULT 1
);
CREATE TABLE access_passkey (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES account_security(user_id) ON DELETE CASCADE,
  public_key bytea NOT NULL,
  counter bigint NOT NULL,
  name text NOT NULL,
  transports jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE TABLE access_device (
  device_hash text PRIMARY KEY,
  user_code text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','consumed')),
  session_id text REFERENCES session(id) ON DELETE CASCADE,
  epoch integer,
  last_poll_at timestamptz
);
CREATE TABLE account_photo (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES account_security(user_id) ON DELETE CASCADE,
  bytes bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE account_reset (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  operator text,
  reason text,
  capability_hash text UNIQUE,
  expires_at timestamptz,
  used_at timestamptz
);

ALTER TABLE message ADD COLUMN author_avatar jsonb;
