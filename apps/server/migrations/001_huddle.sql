CREATE TABLE workspace (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  cursor bigint NOT NULL DEFAULT 0 CHECK (cursor >= 0)
);
CREATE TABLE membership (
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'member')),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX membership_user ON membership(user_id);
CREATE TABLE channel (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  name text NOT NULL,
  UNIQUE (workspace_id, name)
);
CREATE TABLE message (
  id uuid PRIMARY KEY,
  channel_id uuid NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  author_id text NOT NULL REFERENCES "user"(id),
  author_name text NOT NULL,
  retry_id uuid NOT NULL,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
  cursor bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (author_id, retry_id)
);
CREATE INDEX message_history ON message(channel_id, cursor DESC);
CREATE TABLE workspace_event (
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  cursor bigint NOT NULL,
  event jsonb NOT NULL,
  PRIMARY KEY (workspace_id, cursor)
);
CREATE TABLE invitation (
  code_hash text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  consumed_by text REFERENCES "user"(id),
  consumed_at timestamptz
);
