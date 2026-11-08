ALTER TABLE message ADD COLUMN revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  ADD COLUMN edited_at timestamptz,
  ADD COLUMN original_body text;
ALTER TABLE direct_message ADD COLUMN revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  ADD COLUMN edited_at timestamptz,
  ADD COLUMN original_body text;
ALTER TABLE group_message ADD COLUMN revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  ADD COLUMN edited_at timestamptz,
  ADD COLUMN original_body text;
UPDATE message SET original_body = body;
UPDATE direct_message SET original_body = body;
UPDATE group_message SET original_body = body;
ALTER TABLE message ALTER COLUMN original_body SET NOT NULL;
ALTER TABLE direct_message ALTER COLUMN original_body SET NOT NULL;
ALTER TABLE group_message ALTER COLUMN original_body SET NOT NULL;
CREATE TABLE message_edit_receipt (
  author_id text NOT NULL REFERENCES "user"(id),
  retry_id uuid NOT NULL,
  request jsonb NOT NULL,
  response jsonb NOT NULL,
  PRIMARY KEY (author_id, retry_id)
);
