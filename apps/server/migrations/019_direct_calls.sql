CREATE SEQUENCE direct_call_revision;
CREATE TABLE direct_call (
  id uuid PRIMARY KEY,
  room_name text NOT NULL UNIQUE DEFAULT ('direct-' || gen_random_uuid()::text),
  media_joined boolean NOT NULL DEFAULT false,
  conversation_id uuid NOT NULL REFERENCES direct_conversation(id) ON DELETE CASCADE,
  caller_id text NOT NULL REFERENCES "user"(id),
  callee_id text NOT NULL REFERENCES "user"(id),
  state text NOT NULL CHECK (state IN ('ringing', 'accepted', 'ended')),
  revision bigint NOT NULL DEFAULT nextval('direct_call_revision'),
  deadline timestamptz NOT NULL,
  reason text CHECK (reason IN ('declined', 'cancelled', 'hangup', 'timeout', 'join-timeout', 'disconnected', 'access-lost', 'restart')),
  token_expires_at timestamptz NOT NULL DEFAULT now(),
  CHECK (caller_id <> callee_id),
  CHECK ((state = 'ended') = (reason IS NOT NULL))
);
CREATE INDEX direct_call_participants ON direct_call(caller_id, callee_id) WHERE state <> 'ended';
