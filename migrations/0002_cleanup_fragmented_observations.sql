-- Restore Fragmented Observations
--
-- In v2.0.0, a bug caused observation arrays passed as JSON strings
-- to be iterated character-by-character. "I love this" became separate
-- observations: "I", " ", "l", "o", "v", "e", " ", "t", "h", "i", "s"
-- Fixed in v2.2.1, but the fragmented data remains.
--
-- This is a PREVIEW ONLY. The actual restoration requires the script
-- at scripts/restore-fragmented.js because SQLite can't group-concatenate
-- sequential single-char observations back into sentences.
--
-- Step 1: Preview fragmented observations (single characters):
SELECT o.id, o.entity_id, o.content, o.added_at, e.name as entity_name
FROM observations o
JOIN entities e ON o.entity_id = e.id
WHERE LENGTH(TRIM(o.content)) <= 1
ORDER BY o.entity_id, o.id;

-- Step 2: Run the restoration script:
-- node scripts/restore-fragmented.js
--
-- The script will:
-- 1. Find runs of single-character observations on the same entity
-- 2. Reconstruct the original text by concatenating them in order
-- 3. Replace the fragments with one restored observation
-- 4. Show you the result before committing
