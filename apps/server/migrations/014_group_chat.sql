CREATE TABLE group_conversation (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  creator_id text NOT NULL REFERENCES "user"(id),
  create_retry_id uuid NOT NULL,
  create_others text[] NOT NULL,
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (creator_id, create_retry_id)
);
CREATE TABLE group_member (
  group_id uuid NOT NULL REFERENCES group_conversation(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id),
  admission bigint NOT NULL CHECK (admission > 0),
  read_cursor bigint NOT NULL CHECK (read_cursor >= admission),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX group_member_user ON group_member(user_id, group_id);
CREATE TABLE group_message (
  id uuid PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES group_conversation(id),
  author_id text NOT NULL REFERENCES "user"(id),
  author_admission bigint NOT NULL,
  author_name text NOT NULL,
  author_avatar jsonb,
  retry_id uuid NOT NULL,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
  cursor bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (author_id, retry_id)
);
CREATE INDEX group_message_history ON group_message(group_id, cursor DESC);
ALTER TABLE event ADD COLUMN group_id uuid REFERENCES group_conversation(id),
  ADD CONSTRAINT event_group_scope CHECK ((group_id IS NOT NULL) = (event->>'kind' LIKE 'group.%')),
  ADD CONSTRAINT event_group_has_audience CHECK (group_id IS NULL OR audience IS NOT NULL);
