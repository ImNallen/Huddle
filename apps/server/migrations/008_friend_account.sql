DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT conname INTO constraint_name
  FROM pg_constraint
  WHERE conrelid = 'session_proof'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%method%';
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE session_proof DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;
ALTER TABLE session_proof
  ADD CONSTRAINT session_proof_method_check
  CHECK (method IN ('totp', 'recovery', 'passkey', 'company', 'password'));

CREATE TABLE login (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  username text NOT NULL UNIQUE CHECK (username = lower(username) AND username ~ '^[a-z0-9][a-z0-9_-]{1,31}$'),
  password_hash text NOT NULL
);

CREATE TABLE join_code (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  code_hash text NOT NULL,
  sealed_code text NOT NULL
);
