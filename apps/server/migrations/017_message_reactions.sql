ALTER TABLE message ADD COLUMN reaction_revision bigint NOT NULL DEFAULT 0 CHECK (reaction_revision >= 0);
CREATE TABLE message_reaction (
 message_id uuid NOT NULL REFERENCES message(id) ON DELETE CASCADE,
 user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 emoji text NOT NULL,
 person jsonb NOT NULL,
 PRIMARY KEY(message_id,user_id,emoji)
);
ALTER TABLE direct_message ADD COLUMN reaction_revision bigint NOT NULL DEFAULT 0 CHECK (reaction_revision >= 0);
CREATE TABLE direct_message_reaction (
 message_id uuid NOT NULL REFERENCES direct_message(id) ON DELETE CASCADE,
 user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 emoji text NOT NULL,
 person jsonb NOT NULL,
 PRIMARY KEY(message_id,user_id,emoji)
);
ALTER TABLE group_message ADD COLUMN reaction_revision bigint NOT NULL DEFAULT 0 CHECK (reaction_revision >= 0);
CREATE TABLE group_message_reaction (
 message_id uuid NOT NULL REFERENCES group_message(id) ON DELETE CASCADE,
 user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 emoji text NOT NULL,
 person jsonb NOT NULL,
 PRIMARY KEY(message_id,user_id,emoji)
);
CREATE TABLE message_reaction_receipt (
 user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 retry_id uuid NOT NULL,
 request jsonb NOT NULL,
 response jsonb NOT NULL,
 channel_message_id uuid REFERENCES message(id) ON DELETE CASCADE,
 direct_message_id uuid REFERENCES direct_message(id) ON DELETE CASCADE,
 group_message_id uuid REFERENCES group_message(id) ON DELETE CASCADE,
 PRIMARY KEY(user_id,retry_id),
 CHECK (request->>'kind' IS NOT NULL AND request->>'kind' IN ('channel','direct','group')),
 CHECK (num_nonnulls(channel_message_id,direct_message_id,group_message_id)=1),
 CHECK ((channel_message_id IS NOT NULL) = (request->>'kind' = 'channel')),
 CHECK ((direct_message_id IS NOT NULL) = (request->>'kind' = 'direct')),
 CHECK ((group_message_id IS NOT NULL) = (request->>'kind' = 'group'))
);
ALTER TABLE event DROP CONSTRAINT event_channel_scope;
ALTER TABLE event ADD CONSTRAINT event_channel_scope CHECK ((channel_id IS NOT NULL) = (event->>'kind' IN
 ('channel.created','channel.renamed','message.created','message.edited','message.reactions.changed')));
