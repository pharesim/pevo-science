-- Add CHECK constraint to prevent negative last_digest_block
ALTER TABLE notification_preferences
  ADD CONSTRAINT last_digest_block_non_negative CHECK (last_digest_block >= 0);
