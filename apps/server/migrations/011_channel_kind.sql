ALTER TABLE channel ADD COLUMN kind text;
UPDATE channel SET kind = 'text';
ALTER TABLE channel
  ALTER COLUMN kind SET NOT NULL,
  ADD CONSTRAINT channel_kind_check CHECK (kind IN ('text', 'voice'));
UPDATE event
SET event = jsonb_set(event, '{channel,kind}', '"text"')
WHERE event->>'kind' = 'channel.created';
