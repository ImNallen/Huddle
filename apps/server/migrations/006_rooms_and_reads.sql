CREATE TABLE room (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  UNIQUE (id, workspace_id)
);
CREATE UNIQUE INDEX room_name ON room(workspace_id, lower(name));
ALTER TABLE channel ADD COLUMN room_id uuid;
INSERT INTO room(id, workspace_id, name)
SELECT gen_random_uuid(), workspace_id, 'General' FROM channel GROUP BY workspace_id;
UPDATE channel SET room_id = room.id FROM room WHERE room.workspace_id = channel.workspace_id;
ALTER TABLE channel
  ALTER COLUMN room_id SET NOT NULL,
  ADD CONSTRAINT channel_room_fkey FOREIGN KEY (room_id, workspace_id)
    REFERENCES room(id, workspace_id) ON DELETE CASCADE,
  DROP CONSTRAINT channel_workspace_id_name_key,
  ADD CONSTRAINT channel_room_id_name_key UNIQUE (room_id, name);
UPDATE workspace_event
SET event = jsonb_set(event, '{channel,roomId}', to_jsonb(channel.room_id::text))
FROM channel
WHERE event->>'kind' = 'channel.created' AND channel.id = (event->'channel'->>'id')::uuid;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM workspace_event
    WHERE event->>'kind' = 'channel.created' AND NOT event->'channel' ? 'roomId'
  ) THEN
    RAISE EXCEPTION 'channel.created events without a channel cannot be given a roomId';
  END IF;
END $$;
CREATE TABLE channel_read (
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES channel(id) ON DELETE CASCADE,
  cursor bigint NOT NULL,
  PRIMARY KEY (user_id, channel_id)
);
CREATE TABLE message_mention (
  message_id uuid NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX message_mention_user ON message_mention(user_id);
