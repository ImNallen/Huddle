CREATE TABLE watch_ticket (
  hash text PRIMARY KEY,
  session_id text NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX watch_ticket_expiry ON watch_ticket(expires_at);
