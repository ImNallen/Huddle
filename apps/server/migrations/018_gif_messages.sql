CREATE FUNCTION huddle_gif_ok(gif jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  -- A CHECK passes on NULL, so every missing or mistyped key must end in false.
  SELECT coalesce(
    jsonb_typeof(gif) = 'object'
    AND gif ?& ARRAY['slug', 'title', 'width', 'height', 'animated', 'still']
    AND gif - ARRAY['slug', 'title', 'width', 'height', 'animated', 'still'] = '{}'::jsonb
    AND jsonb_typeof(gif->'slug') = 'string' AND length(gif->>'slug') BETWEEN 1 AND 200
    AND jsonb_typeof(gif->'title') = 'string' AND length(gif->>'title') <= 200
    -- CASE fixes the evaluation order, so a string never reaches the numeric cast.
    AND CASE WHEN jsonb_typeof(gif->'width') = 'number'
      THEN (gif->>'width')::numeric BETWEEN 1 AND 4096 AND (gif->>'width')::numeric % 1 = 0
      ELSE false END
    AND CASE WHEN jsonb_typeof(gif->'height') = 'number'
      THEN (gif->>'height')::numeric BETWEEN 1 AND 4096 AND (gif->>'height')::numeric % 1 = 0
      ELSE false END
    AND jsonb_typeof(gif->'animated') = 'string' AND length(gif->>'animated') <= 2048
    AND gif->>'animated' ~ '^https://static[12]?\.klipy\.com/[!-~]*$'
    AND jsonb_typeof(gif->'still') = 'string' AND length(gif->>'still') <= 2048
    AND gif->>'still' ~ '^https://static[12]?\.klipy\.com/[!-~]*$',
  false)
$$;
ALTER TABLE message ADD COLUMN gif jsonb,
  ADD CONSTRAINT message_gif_ok CHECK (gif IS NULL OR huddle_gif_ok(gif)),
  ADD CONSTRAINT message_gif_unedited
    CHECK (gif IS NULL OR (revision = 0 AND edited_at IS NULL AND body = original_body));
ALTER TABLE direct_message ADD COLUMN gif jsonb,
  ADD CONSTRAINT direct_message_gif_ok CHECK (gif IS NULL OR huddle_gif_ok(gif)),
  ADD CONSTRAINT direct_message_gif_unedited
    CHECK (gif IS NULL OR (revision = 0 AND edited_at IS NULL AND body = original_body));
ALTER TABLE group_message ADD COLUMN gif jsonb,
  ADD CONSTRAINT group_message_gif_ok CHECK (gif IS NULL OR huddle_gif_ok(gif)),
  ADD CONSTRAINT group_message_gif_unedited
    CHECK (gif IS NULL OR (revision = 0 AND edited_at IS NULL AND body = original_body));
