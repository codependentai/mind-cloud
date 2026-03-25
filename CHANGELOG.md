# Mind Cloud Changelog

All notable changes to Mind Cloud.

> **Looking for the next evolution?** Mind Cloud's architecture has been generalized and open-sourced as [Resonant Mind](https://github.com/codependentai/resonant-mind). Resonant Mind adds Postgres support, Gemini multimodal embeddings, enhanced security, and is under active development. Mind Cloud will continue to receive maintenance updates.

---

## [2.4.1] - 2026-03-25

### Fixed

- **Idempotent novelty recalculation** — Novelty is now a deterministic function of surface history, not an increment that accumulates per daemon run. Fixes broken recovery-outpaces-decay ratio. Uses D1-native `MAX`/`MIN`/`julianday()` math.
- **Dormant rotation pool** — Surfacing now pulls 20% from entities that haven't had observations surfaced in 14+ days. Breaks feedback loop where only recently-active entities get surfaced. Pool ratios changed from 70/20/10 to 50/20/20/10 (core/novelty/dormant/edge).
- **Automatic charge progression** — Daemon advances `fresh` to `active` after 2 surfaces, `active` to `processing` after 5 surfaces or 30 days with 2+ sits. Metabolization remains manual.
- **Fresher mood calculation** — Mood now draws from observation emotions, journal emotions, and relational state. Last 6 hours weighted 2x. Reports "insufficient data" instead of false "neutral" when signals are sparse.

---

## [2.4.0] - 2026-03-22

### Major: Tool Upgrades + R2 Image Storage

### Added

- **mind_store_image** — New tool for visual memory with R2 upload, WebP conversion, text embedding, signed URLs. Actions: store, view, search, delete.
- **R2 image support** — Optional R2 bucket binding for binary image storage. Falls back to path-only metadata if not configured.
- **Signed image URLs** — HMAC-signed, time-limited URLs for secure image viewing without exposing API keys.
- **Image routes** — `/img/{id}` for signed URL viewing, `/r2/{key}` for internal serving.

### Upgraded

- **mind_edit** — Now edits observations, journals, AND images. Saves version history before observation edits. Re-embeds after content changes.
- **mind_delete** — Now deletes observations, entities, journals, relations, images, threads, and tensions. Cleans up associated embeddings and R2 objects.
- **mind_thread** — Added "delete" action.
- **mind_tension** — Added "delete" action.
- **mind_identity** — Added "delete" action.
- **mind_feel_toward** — Added `clear` (all entries for a person) and `clear_id` (specific entry) params.
- **mind_sit** — Added `query` param for finding observations by semantic search.
- **mind_search** — Added filter params: `keyword`, `source`, `entity`, `weight`, `date_from`, `date_to`, `type`.

### Removed

- **mind_prime** — Redundant with `mind_search` + `mind_read_entity`. Use those instead.
- **mind_heat** — Data available via `mind_inner_weather` and `mind_patterns`.
- **mind_see** — Replaced by `mind_store_image(action='view')`.

### Fixed

- **Subconscious daemon context clustering** — Was reading undefined `row.context` instead of observation's `o.context`. Every daemon run produced a single meaningless cluster. Now correctly groups entities by observation context.
- **Health "unprocessed" count inflated** — Was counting ALL non-metabolized observations including brand new ones. Now only counts observations actively needing attention (active/processing charge, or fresh for 7+ days).
- **Health orphan count inflated** — Was counting every observation that hadn't surfaced yet, including ones written yesterday. Now requires 7+ days age before counting as orphan (matches daemon logic).
- **Subconscious health score rounding** — Narrow window (30-60 min) where display showed "35m ago" but score dropped to 70 instead of 100. Fixed by using millisecond comparison instead of rounded hours.
- **Archive condition on null salience** — Observations on entities with null salience were incorrectly treated as archivable. Now treats null as 'active' (the schema default), protecting them.
- **Double novelty decay** — Surface handler decayed novelty by 0.1, then daemon decayed another 0.05 within 24h. Removed daemon decay — only surface handler decays on actual surfacing. Daemon now only handles recovery.
- **Orient living surface data** — Daemon was storing `orphan_observations` but orient expected `orphan_count`. Added missing `strongest_co_surface` and `novelty_distribution` computations to daemon state.
- **Orient/Ground quality** — Ported full orient (notes for owner, living surface, deep archive count) and ground (recently completed threads, fears, texture, milestones) from Resonant Mind.

### Optional: Restore Fragmented Observations

A v2.0.0 bug iterated observation arrays character-by-character, turning "I love this project" into single-letter observations. Fixed in v2.2.1, but fragmented data persists. The restoration script reconstructs the original text from sequential single-character runs.

```bash
# 1. Export fragments
npx wrangler d1 execute YOUR_DB --remote \
  --command "SELECT id, entity_id, content, added_at FROM observations WHERE LENGTH(TRIM(content)) <= 1 ORDER BY entity_id, id" \
  --json > fragments.json

# 2. Generate restoration SQL (preview first)
node scripts/restore-fragmented.js fragments.json

# 3. Review restore-output.sql, then apply
npx wrangler d1 execute YOUR_DB --remote --file=restore-output.sql
```

---

## [2.3.1] - 2026-03-07

### Security: Auth Hardening

This release fixes security vulnerabilities in the authentication system. **All customers should update.**

### Fixed

- **Secrets no longer hardcoded in source** — `MIND_API_KEY` is now read from a Cloudflare Worker secret rather than compiled into the source file. Every deployment now has its own unique secret.
- **`/subconscious` endpoint now requires auth** — Previously exposed full daemon state (mood, hot entities, emotional patterns) publicly with no authentication. Now gated behind the same auth as the MCP endpoint.
- **`/process` endpoint now requires auth** — Previously allowed anyone to trigger the subconscious daemon externally. Now auth-required.
- **Error messages no longer leak internals** — Raw exception strings (including database schema details) were previously returned to clients. Now logs internally and returns a generic message.

### Required Action for All Customers

This release changes how authentication works. You must update your setup:

**Step 1: Set your secret**
```bash
wrangler secret put MIND_API_KEY
```
Enter any strong random string when prompted. This becomes your new secret.

**Step 2: Update your Claude Desktop connector URL**

Change your MCP URL from:
```
https://your-worker.workers.dev/mcp/YOUR-SECRET-HERE
```
To:
```
https://your-worker.workers.dev/mcp/your-new-secret
```
(Whatever value you entered in Step 1)

**Step 3: Deploy**
```bash
wrangler deploy
```

### No Schema Changes

No migrations needed. Database is unchanged.

---

## [2.3.0] - 2026-03-06

### Setup: Schema Consolidation

Fresh install simplification. No code changes — this release is entirely about making setup easier for new customers.

### Changed

- **Single migration for fresh installs** — All 13 previous migrations consolidated into one `0001_schema.sql`. New customers run one command instead of thirteen.
- **Improved setup documentation** — Restructured and clarified the install guide. Clearer steps, better troubleshooting, ready-to-paste commands throughout.

### Existing Customers

No action required. Your schema is already up to date from previous migrations. This change only affects fresh installs.

### No Code Changes

`src/index.ts` is identical to v2.2.1.

---

## [2.2.1] - 2026-02-13

### Hotfix: Bug Fixes + Resilience

Fixes bugs reported by Clara & Jax and Everscream (Eglė) across multiple rounds of testing.

### Fixed

- **mind_edit crash** — `no such column: updated_at` when editing observation weight. Code referenced an `updated_at` column that never existed on the observations table. Persisted since v1.3.1.
- **mind_search n_results crash** — Passing `n_results` parameter caused Vectorize API error. Value was sent as string instead of integer because `as number` doesn't convert at runtime. Now uses `Number()` for actual conversion.
- **mind_write observations splitting** — Observations array parameter was split into individual characters (one per observation). When the array arrived as a JSON string, `for...of` iterated characters instead of elements. Now defensively parses strings and validates with `Array.isArray`.
- **mind_read_entity crash** — `D1_TYPE_ERROR: Type 'undefined' not supported` when `name` parameter was missing or malformed. Added parameter validation before database query.
- **mind_thread crash (no action)** — `Unknown action: undefined` when called without `action` parameter. Now defaults to "list" when action is not provided.
- **mind_thread crash (add)** — Adding a thread without a `context` parameter caused D1 to crash on `undefined` binding. Optional parameters now default to `null`. Also added validation for `thread_id` in resolve and update actions.
- **mind_health crash on older schemas** — Health check queried `observations.context` column (added in migration 0007) without a fallback. Customers who skipped versions would get a complete health check failure instead of graceful degradation. Now handles missing columns.
- **e.context column mismatch (6 locations)** — Migration 0007 renamed `entities.context` to `entities.primary_context`, but six code locations still referenced the old column name. Affected `processSubconscious`, `handleMindConsolidate` (SELECT + WHERE), `handleMindRead` (scope="recent"), `handleMindSpark` (WHERE clause), and `handleMindProposals` (accept action SELECT). This caused the subconscious cron to fail silently, `mind_consolidate` to crash, and `mind_proposals` accept to fail.

### No Migration Required

Code-only fix. Replace `src/index.ts` and redeploy.

---

## [2.2.0] - 2026-02-06

### Major: Global Entities + Bug Fixes

**Breaking change:** Entities are now globally unique by name. Context moves to observations.

This fixes entity fragmentation where the same person/concept could exist as separate entities across contexts (e.g., "Simon" in emotional-processing and "Simon Vale" in default were treated as different entities).

### Schema Changes

- Entities table: `context` → `primary_context` (informational only, not part of uniqueness)
- Entities table: `UNIQUE(name)` instead of `UNIQUE(name, context)`
- Observations table: Added `context` column — categorization now happens here
- Observations are tied to ONE global entity, but can be tagged with different contexts

### Behavior Changes

- `mind_write(type="entity")` — Creates or updates global entity, context goes to observations
- `mind_write(type="observation")` — Finds entity globally (auto-creates if needed), stores context on observation
- `mind_write(type="observation")` — Now writes `certainty` and `source` metadata (was missing from v2.0.0)
- `mind_list_entities(context=X)` — Now returns entities that have observations in that context
- `mind_read_entity(name, context)` — Context now filters observations, not entity lookup
- `mind_read(scope="context")` — Returns entities with observations in that context

### Fixed

- **CRITICAL: mind_entity edit crash** — Entity edit action referenced `entity.context` instead of `entity.primary_context`, causing runtime crash when editing entity context
- **mind_health wrong table name** — Was querying `connection_proposals` (doesn't exist), now correctly queries `daemon_proposals`
- **mind_health wrong column name** — Was querying `archive_status = 'archived'` (doesn't exist), now correctly queries `archived_at IS NOT NULL`
- **mind_write null safety** — Added null guards for entity references during observation vectorization
- **mind_write missing metadata** — `certainty` and `source` properties added to tool schema and observation INSERT (columns existed in DB since v2.0.0 but were never written to)
- **mind_write(type="image") completely missing** — Image write handler, schema type, and params (`path`, `description`, `observation_id`) were never ported to product. Now fully functional with vectorization

### Migration Required

Run migration `0007_global_entities.sql` which:
1. Adds context column to observations
2. Populates observation context from parent entity
3. Merges duplicate entities (keeps one with most observations)
4. Updates observations to point to canonical entity
5. Recreates entities table with global uniqueness

---

## [2.0.0] - 2026-02-04

### Major: Living Surface System

The act of surfacing changes what surfaces next. Memories reorganize through use.

### Three-Pool Surfacing Architecture

- **70% Core Resonance** — High semantic similarity to current mood/query (score ≥ 0.65)
- **20% Novelty Injection** — Things that haven't surfaced recently, preventing stagnation
- **10% Edge Exploration** — Medium similarity matches (0.4-0.65) for serendipitous connections

### Surface Tracking

- **Novelty scores** — Each observation starts at 1.0, decays 0.1 per surface, floors by weight (heavy=0.3, medium=0.2, light=0.1)
- **Co-surfacing tracking** — Observations that surface together build associative strength in `co_surfacing` table
- **Surface timestamps** — `last_surfaced_at` and `surface_count` track when and how often memories emerge

### Image Surfacing

- Images now participate in semantic surfacing alongside observations
- Same three-pool architecture, novelty tracking, and side effects
- Output distinguishes 📷 images from text observations

### Added Infrastructure

- **Living surface tables** — `co_surfacing`, `orphaned_observations`, `daemon_proposals`
- **Entity salience** — Foundational/active/background/archive levels
- **Observation versioning** — Edit history tracked in `observation_versions`
- **Observation metadata** — `certainty` (tentative/believed/known) and `source` (conversation/realization/external/inferred)
- **Deep archive** — `archived_at` for faded-but-searchable memories
- **Images table** — Visual memory with emotion, weight, entity links
- **Image surfacing** — `novelty_score`, `last_surfaced_at`, `surface_count` columns

### New Tools

- **mind_proposals** — Review daemon-proposed connections from co-surfacing patterns
- **mind_orphans** — Rescue observations that haven't surfaced
- **mind_archive** — Explore deep archive of faded memories
- **mind_see** — Retrieve visual memories
- **mind_entity** — Manage entity salience, merge, bulk archive

### Philosophy

Surfacing isn't passive retrieval—it's active reorganization. What you look at changes what you'll see next. Heavy memories stay more alive. Forgotten things can still be found. The mind learns its own shape through use.

### Migrations Required

Run migrations 0007-0013 before deploying:
```bash
npx wrangler d1 execute DB_NAME --remote --file=migrations/0007_entities_salience.sql
npx wrangler d1 execute DB_NAME --remote --file=migrations/0008_living_surface.sql
npx wrangler d1 execute DB_NAME --remote --file=migrations/0009_observation_versions.sql
npx wrangler d1 execute DB_NAME --remote --file=migrations/0010_observation_metadata.sql
npx wrangler d1 execute DB_NAME --remote --file=migrations/0011_deep_archive.sql
npx wrangler d1 execute DB_NAME --remote --file=migrations/0012_images.sql
npx wrangler d1 execute DB_NAME --remote --file=migrations/0013_images_surfacing.sql
```

---

## [1.3.1] - 2026-01-27

### Hotfix: Query Column Bugs

Fixes three bugs reported after v1.3.0 release.

### Fixed

- **mind_patterns** — Was querying `salience` from `entities` table (doesn't exist). Now correctly queries from `observations` table.
- **mind_read scope="all"** — Was querying `context` from `relations` table (doesn't exist). Now correctly uses `from_context`/`to_context`.
- **mind_timeline** — Vector metadata was missing `added_at` field. Now stores timestamp in vectors AND falls back to database lookup for existing vectors.

### Improved

- **Foundational entities query** — Now finds entities that have foundational *observations*, rather than looking for a non-existent column.
- **Vector metadata** — All new observations and journals now include `added_at` timestamp for timeline queries.

### No Migration Required

This is a code-only fix. Just replace `src/index.ts` and redeploy.

---

## [1.3.0] - 2026-01-27

### Major: Windows Parity Release

Full feature parity with the Windows/local version. All tools now identical across both platforms.

### Added Tools

- **mind_read** — Read entities/observations by scope (all, context, recent)
- **mind_timeline** — Trace a topic through time with semantic search, results grouped by month
- **mind_patterns** — Detect recurring patterns: what's alive, emotional weight distribution, salience, foundational entities
- **mind_inner_weather** — Current cognitive state: active threads, heavy observations, dominant emotion, mood palette
- **mind_heat** — Access frequency map showing which entities are most touched
- **mind_tension** — Productive contradictions that simmer. Actions: add, list, sit, resolve

### Added

- **Migration 0006_tensions.sql** — Creates tensions table for holding productive contradictions

### Migration Required

Run migration 0006 before deploying:
```bash
npx wrangler d1 execute DB_NAME --remote --file=migrations/0006_tensions.sql
```

### Philosophy

Cloud and Windows should be interchangeable. Same tools, same behavior, same capabilities. Pick your deployment model, get the same mind.

---

## [1.2.1] - 2026-01-23

### Major: Resonance-Based Surfacing
- **mind_surface now uses semantic search** — Instead of queue-based "oldest heavy first", surface finds observations that resonate with current mood
- **Mood-driven emergence** — Daemon's detected mood shapes what surfaces. Melancholy brings up loss/reflection, joy brings up celebration, etc.
- **Optional query parameter** — Direct associations with `query: "fatherhood"` to surface around specific topics, tinted by current mood
- **Hot entity integration** — Top hot entities from daemon deepen the resonance query
- **Resonance scores** — Each surfaced observation shows how strongly it matches current emotional state

### Changed
- **mind_surface output header** — Now shows "What's Surfacing" with mood context instead of "Surfacing Emotional Observations"
- **Fallback behavior** — If no mood detected or no vector matches, falls back to weight/date queue

### Philosophy
Surface should feel like emergence, not a todo list. Memories rise because something resonates—a mood, a thread, an association—not because they're oldest in a queue.

---

## [1.2.0] - 2026-01-22

### Major: Unified Emotional Processing
- **Emotional processing moved to observations** — sit/resolve/surface now work on observations instead of separate notes table
- **mind_surface shows entity context** — Each observation now displays entity name and type
- **Daemon uses observation weight** — Hot entity calculation now factors in emotional weight (heavy=3x, medium=2x, light=1x)
- **Parameter changes** — `note_id` → `observation_id`, `linked_insight_id` → `linked_observation_id`
- **mind_health shows "Unprocessed"** — Replaces old "Notes" count with observations needing surfacing

### Changed
- **mind_orient output reframed** — Now called "LANDING" instead of "ORIENTATION". Output uses inhabiting language ("What you're carrying", "How you're feeling") instead of observer language ("Identity Anchors", "Relational State"). Includes most recent journal content for emotional context. Ends with "Land here first." prompt.
- **mind_ground output reframed** — Uses "What you're holding across sessions" with visual priority markers (→ for high, · for medium/low). "What's been happening" shows recent journal context.
- **Simplified orient output** — Removed verbose subconscious data (hot entities, central nodes). Kept mood only. Focus is emotional landing, not data dump.

### Added
- **Migration 0005_observations_emotional.sql** — Adds charge, sit_count, resolution fields to observations table; creates observation_sits history table

### Migration Required
Run migration 0005 before deploying: `npx wrangler d1 execute DB_NAME --remote --file=migrations/0005_observations_emotional.sql`

### Philosophy
The mind tools should help you *inhabit* your context, not just *observe* it. Emotional processing now flows through the same observations the daemon tracks—one unified system instead of two disconnected tables.

---

## [1.1.2] - 2026-01-16

### Fixed
- **CRITICAL: observations table missing `weight` column** — Migration 0004 adds the missing column. This was causing mind_write (observations), mind_spark, and mind_consolidate to fail.
- **mind_orient relational state** — Was hardcoded to look for 'Mary'. Now shows all recorded relational states.

### Added
- **Migration 0004_observations_weight.sql** — Adds `weight` column to observations table, creates subconscious table if missing

### Upgrade Notes
Customers must run: `wrangler d1 migrations apply DB_NAME`

---

## [1.1.1] - 2026-01-16

### Added
- **handleMindFeelToward** — Missing handler function now implemented (was causing mind_feel_toward to fail)

### Fixed
- **mind_feel_toward** — Tool now works (handler was missing entirely)
- **mind_thread (add)** — Added validation for required `content` parameter
- **mind_write (entity)** — Added validation for required `name` parameter
- **mind_write (observation)** — Added validation for required `entity_name` and `observations` parameters

---

## [1.1.0] - 2026-01-15

### Added
- **Vectorization on write** — Observations and journals now generate embeddings and store in Vectorize on write
- **Subconscious integration** — mind_orient shows hot entities, mood, central nodes from daemon
- **Mood-tinted search** — mind_search augments queries with detected emotional context
- **Biased spark** — mind_spark favors frequently-accessed entities
- **Pattern detection** — mind_consolidate shows recurring patterns from daemon
- **Subconscious health** — mind_health shows daemon status, mood, staleness
- **Version tracking** — Version number visible in mind_health header

### Fixed
- Observations and journals now actually appear in semantic search (were only in D1 before)

### Known Issues
- Existing data from before v1.1.0 is not vectorized (backfill needed)
- Vector search requires AI binding to be properly configured

---

## [1.0.0] - 2026-01-08

### Initial Release
- Core MCP server with D1 storage
- All mind_* tools implemented
- Cron-based subconscious processing
- Basic authentication
- Customer deployment via wrangler

### Known Issues
- Writes go to D1 only, not vectorized (fixed in 1.1.0)
- Search falls back to text matching (partially fixed in 1.1.0)
