DO $$
DECLARE
  workspaces bigint := (SELECT count(*) FROM workspace);
BEGIN
  IF workspaces > 1 THEN
    RAISE EXCEPTION 'This database has % workspaces, but a Huddle server now holds exactly one. It predates single-server mode and cannot be migrated. Reset it: drop and recreate the database, run pnpm db:migrate, then onboard with the setup code from the server log.', workspaces;
  END IF;
END $$;

CREATE TABLE server (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  name text NOT NULL,
  cursor bigint NOT NULL DEFAULT 0 CHECK (cursor >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO server(name, cursor) SELECT name, cursor FROM workspace;

CREATE TABLE member (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO member(user_id, role)
SELECT user_id, CASE role WHEN 'owner' THEN 'admin' ELSE role END FROM membership;
DROP TABLE membership;

ALTER TABLE channel DROP CONSTRAINT channel_room_fkey;
DROP INDEX room_name;
ALTER TABLE room DROP CONSTRAINT room_id_workspace_id_key, DROP COLUMN workspace_id;
CREATE UNIQUE INDEX room_name ON room (lower(name));
ALTER TABLE channel
  DROP COLUMN workspace_id,
  ADD CONSTRAINT channel_room_fkey FOREIGN KEY (room_id) REFERENCES room(id) ON DELETE CASCADE;

CREATE TABLE event (
  cursor bigint PRIMARY KEY CHECK (cursor > 0),
  event jsonb NOT NULL
);
INSERT INTO event(cursor, event)
SELECT cursor, event #- '{room,workspaceId}' #- '{channel,workspaceId}' FROM workspace_event;
DROP TABLE workspace_event;

DROP TABLE invitation;
CREATE TABLE invitation (
  email text PRIMARY KEY CHECK (email = lower(email)),
  invited_by text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  accepted_by text REFERENCES "user"(id) ON DELETE CASCADE,
  accepted_at timestamptz,
  CHECK ((accepted_by IS NULL) = (accepted_at IS NULL))
);
DROP TABLE workspace;

CREATE TABLE setup_code (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL
);
