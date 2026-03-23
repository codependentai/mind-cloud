-- Cleanup: Fragmented Observations
--
-- In v2.0.0, a bug caused observation arrays passed as JSON strings
-- to be iterated character-by-character. This created single-letter
-- observations like "I", " ", "l", "o", "v", "e" instead of the
-- full sentence. Fixed in v2.2.1 but existing fragmented data remains.
--
-- This migration removes observations that are:
-- - 3 characters or shorter (single letters, spaces, punctuation)
-- - Not meaningful content (just fragments)
--
-- Run: wrangler d1 execute YOUR_DB --remote --file=migrations/0002_cleanup_fragmented_observations.sql
--
-- RECOMMENDED: Review first with the SELECT before running the DELETE.

-- Preview what will be deleted (run this first to review):
-- SELECT o.id, o.content, e.name as entity_name, o.added_at
-- FROM observations o
-- JOIN entities e ON o.entity_id = e.id
-- WHERE LENGTH(TRIM(o.content)) <= 3
-- ORDER BY o.added_at;

-- Delete fragmented observations (single characters and very short fragments)
DELETE FROM observations WHERE LENGTH(TRIM(content)) <= 3;

-- Clean up any orphaned entities that now have zero observations
DELETE FROM entities WHERE id NOT IN (
    SELECT DISTINCT entity_id FROM observations
) AND id NOT IN (
    SELECT DISTINCT entity_id FROM images WHERE entity_id IS NOT NULL
);
