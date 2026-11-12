CREATE TABLE blocked_account (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE deleted_voice_channel (id uuid PRIMARY KEY);

ALTER TABLE event
  ADD COLUMN room_id uuid REFERENCES room(id) ON DELETE CASCADE,
  ADD COLUMN channel_id uuid REFERENCES channel(id) ON DELETE CASCADE;
UPDATE event SET room_id = (event->'room'->>'id')::uuid
WHERE event->>'kind' = 'room.created';
UPDATE event SET room_id = (event->'channel'->>'roomId')::uuid,
  channel_id = (event->'channel'->>'id')::uuid
WHERE event->>'kind' = 'channel.created';
UPDATE event SET channel_id = (event->'message'->>'channelId')::uuid
WHERE event->>'kind' IN ('message.created', 'message.edited');
ALTER TABLE event
  ADD CONSTRAINT event_room_scope CHECK ((room_id IS NOT NULL) = (event->>'kind' IN
    ('room.created', 'room.renamed', 'channel.created', 'channel.renamed', 'channel.deleted'))),
  ADD CONSTRAINT event_channel_scope CHECK ((channel_id IS NOT NULL) = (event->>'kind' IN
    ('channel.created', 'channel.renamed', 'message.created', 'message.edited')));
CREATE INDEX event_room ON event(room_id) WHERE room_id IS NOT NULL;
CREATE INDEX event_channel ON event(channel_id) WHERE channel_id IS NOT NULL;

ALTER TABLE message_edit_receipt
  ADD COLUMN channel_id uuid REFERENCES channel(id) ON DELETE CASCADE;
UPDATE message_edit_receipt SET channel_id = (request->>'channelId')::uuid
WHERE request->>'kind' = 'channel';
ALTER TABLE message_edit_receipt
  ADD CONSTRAINT receipt_channel_scope CHECK ((channel_id IS NOT NULL) = (request->>'kind' = 'channel'));
CREATE INDEX message_edit_receipt_channel ON message_edit_receipt(channel_id)
  WHERE channel_id IS NOT NULL;
