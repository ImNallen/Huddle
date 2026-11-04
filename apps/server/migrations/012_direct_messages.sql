CREATE TABLE direct_conversation (
  id uuid PRIMARY KEY,
  user_a text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  user_b text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (user_a < user_b),
  UNIQUE (user_a, user_b)
);
CREATE INDEX direct_conversation_user_b ON direct_conversation(user_b);
CREATE TABLE direct_message (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES direct_conversation(id) ON DELETE CASCADE,
  author_id text NOT NULL REFERENCES "user"(id),
  author_name text NOT NULL,
  author_avatar jsonb,
  retry_id uuid NOT NULL,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
  cursor bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (author_id, retry_id)
);
CREATE INDEX direct_message_history ON direct_message(conversation_id, cursor DESC);
CREATE TABLE direct_read (
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES direct_conversation(id) ON DELETE CASCADE,
  cursor bigint NOT NULL,
  PRIMARY KEY (user_id, conversation_id)
);
ALTER TABLE event
  ADD COLUMN audience text[],
  ADD CONSTRAINT event_direct_has_audience
    CHECK (audience IS NOT NULL OR event->>'kind' NOT LIKE 'direct.%');
