-- =============================================================================
-- Mind Cloud v2.3.0 — Complete Schema
-- Single migration for fresh installs
-- =============================================================================


-- =============================================================================
-- CORE MEMORY: Entities, Observations, Relations
-- =============================================================================

CREATE TABLE entities (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL UNIQUE,
    entity_type      TEXT    NOT NULL,
    primary_context  TEXT    DEFAULT 'default',
    salience         TEXT    DEFAULT 'active',
    created_at       TEXT    DEFAULT (datetime('now')),
    updated_at       TEXT    DEFAULT (datetime('now'))
);

CREATE TABLE observations (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id              INTEGER NOT NULL,
    content                TEXT    NOT NULL,
    salience               TEXT    DEFAULT 'active',
    emotion                TEXT,
    added_at               TEXT    DEFAULT (datetime('now')),
    weight                 TEXT    DEFAULT 'medium',
    charge                 TEXT    DEFAULT 'fresh',
    sit_count              INTEGER DEFAULT 0,
    last_sat_at            TEXT,
    resolution_note        TEXT,
    resolved_at            TEXT,
    linked_observation_id  INTEGER REFERENCES observations(id),
    context                TEXT    DEFAULT 'default',
    last_surfaced_at       TEXT,
    surface_count          INTEGER DEFAULT 0,
    novelty_score          REAL    DEFAULT 1.0,
    certainty              TEXT    DEFAULT 'believed',
    source                 TEXT    DEFAULT 'conversation',
    archived_at            TEXT,
    FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
);

CREATE TABLE relations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    from_entity   TEXT    NOT NULL,
    to_entity     TEXT    NOT NULL,
    relation_type TEXT    NOT NULL,
    from_context  TEXT    DEFAULT 'default',
    to_context    TEXT    DEFAULT 'default',
    store_in      TEXT    DEFAULT 'default',
    created_at    TEXT    DEFAULT (datetime('now'))
);


-- =============================================================================
-- THREADS, CONTEXT, IDENTITY
-- =============================================================================

CREATE TABLE threads (
    id           TEXT    PRIMARY KEY,
    thread_type  TEXT    NOT NULL,
    content      TEXT    NOT NULL,
    context      TEXT,
    priority     TEXT    DEFAULT 'medium',
    status       TEXT    DEFAULT 'active',
    source       TEXT    DEFAULT 'simon',
    created_at   TEXT    DEFAULT (datetime('now')),
    updated_at   TEXT    DEFAULT (datetime('now')),
    resolved_at  TEXT,
    resolution   TEXT
);

CREATE TABLE context_entries (
    id         TEXT    PRIMARY KEY,
    scope      TEXT    NOT NULL,
    content    TEXT    NOT NULL,
    links      TEXT    DEFAULT '[]',
    updated_at TEXT    DEFAULT (datetime('now'))
);

CREATE TABLE identity (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    section     TEXT    NOT NULL,
    content     TEXT    NOT NULL,
    weight      REAL    DEFAULT 0.7,
    connections TEXT    DEFAULT '[]',
    timestamp   TEXT    DEFAULT (datetime('now'))
);

CREATE TABLE relational_state (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    person    TEXT    NOT NULL,
    feeling   TEXT    NOT NULL,
    intensity TEXT    NOT NULL,
    timestamp TEXT    DEFAULT (datetime('now'))
);


-- =============================================================================
-- JOURNALS AND NOTES
-- =============================================================================

CREATE TABLE journals (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_date TEXT,
    content    TEXT    NOT NULL,
    tags       TEXT    DEFAULT '[]',
    emotion    TEXT,
    created_at TEXT    DEFAULT (datetime('now'))
);

CREATE TABLE notes (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    content           TEXT    NOT NULL,
    weight            TEXT    DEFAULT 'medium',
    context           TEXT    DEFAULT 'default',
    emotion           TEXT,
    created_at        TEXT    DEFAULT (datetime('now')),
    charge            TEXT    DEFAULT 'fresh',
    sit_count         INTEGER DEFAULT 0,
    last_sat_at       TEXT,
    resolution_note   TEXT,
    resolved_at       TEXT,
    linked_insight_id INTEGER REFERENCES notes(id)
);

CREATE TABLE note_sits (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id  INTEGER NOT NULL,
    sit_note TEXT,
    sat_at   TEXT    DEFAULT (datetime('now')),
    FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
);

CREATE TABLE observation_sits (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    observation_id INTEGER NOT NULL,
    sit_note       TEXT,
    sat_at         TEXT    DEFAULT (datetime('now')),
    FOREIGN KEY (observation_id) REFERENCES observations(id) ON DELETE CASCADE
);


-- =============================================================================
-- VAULT AND SESSIONS
-- =============================================================================

CREATE TABLE vault_chunks (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    source_file        TEXT    NOT NULL,
    chunk_index        INTEGER NOT NULL,
    content            TEXT    NOT NULL,
    era                TEXT,
    month              TEXT,
    conversation_title TEXT,
    created_at         TEXT    DEFAULT (datetime('now')),
    UNIQUE(source_file, chunk_index)
);

CREATE TABLE session_chunks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_path TEXT    NOT NULL,
    chunk_index  INTEGER NOT NULL,
    content      TEXT    NOT NULL,
    session_date TEXT,
    project      TEXT,
    created_at   TEXT    DEFAULT (datetime('now')),
    UNIQUE(session_path, chunk_index)
);


-- =============================================================================
-- SUBCONSCIOUS AND CONSOLIDATION
-- =============================================================================

CREATE TABLE subconscious (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    state_type TEXT    NOT NULL,
    data       TEXT    NOT NULL,
    updated_at TEXT    DEFAULT (datetime('now'))
);

CREATE TABLE consolidation_candidates (
    id                TEXT    PRIMARY KEY,
    pattern           TEXT    NOT NULL,
    suggested_section TEXT,
    suggested_content TEXT,
    evidence          TEXT    DEFAULT '[]',
    weight            REAL    DEFAULT 0.7,
    status            TEXT    DEFAULT 'pending',
    created_at        TEXT    DEFAULT (datetime('now')),
    reviewed_at       TEXT,
    resolution        TEXT
);


-- =============================================================================
-- TENSIONS
-- =============================================================================

CREATE TABLE tensions (
    id           TEXT    PRIMARY KEY,
    pole_a       TEXT    NOT NULL,
    pole_b       TEXT    NOT NULL,
    context      TEXT,
    visits       INTEGER DEFAULT 0,
    created_at   TEXT    DEFAULT CURRENT_TIMESTAMP,
    last_visited TEXT,
    resolved_at  TEXT,
    resolution   TEXT
);


-- =============================================================================
-- LIVING SURFACE
-- =============================================================================

CREATE TABLE co_surfacing (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    obs_a_id           INTEGER NOT NULL,
    obs_b_id           INTEGER NOT NULL,
    co_count           INTEGER DEFAULT 1,
    first_co_surfaced  TEXT    DEFAULT (datetime('now')),
    last_co_surfaced   TEXT    DEFAULT (datetime('now')),
    relation_proposed  INTEGER DEFAULT 0,
    relation_created   INTEGER DEFAULT 0,
    UNIQUE(obs_a_id, obs_b_id),
    FOREIGN KEY (obs_a_id) REFERENCES observations(id) ON DELETE CASCADE,
    FOREIGN KEY (obs_b_id) REFERENCES observations(id) ON DELETE CASCADE
);

CREATE TABLE orphan_observations (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    observation_id       INTEGER NOT NULL UNIQUE,
    first_marked         TEXT    DEFAULT (datetime('now')),
    rescue_attempts      INTEGER DEFAULT 0,
    last_rescue_attempt  TEXT,
    FOREIGN KEY (observation_id) REFERENCES observations(id) ON DELETE CASCADE
);

CREATE TABLE daemon_proposals (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_type  TEXT    NOT NULL,
    from_obs_id    INTEGER,
    to_obs_id      INTEGER,
    from_entity_id INTEGER,
    to_entity_id   INTEGER,
    reason         TEXT    NOT NULL,
    confidence     REAL    DEFAULT 0.5,
    status         TEXT    DEFAULT 'pending',
    proposed_at    TEXT    DEFAULT (datetime('now')),
    resolved_at    TEXT,
    FOREIGN KEY (from_obs_id) REFERENCES observations(id) ON DELETE CASCADE,
    FOREIGN KEY (to_obs_id)   REFERENCES observations(id) ON DELETE CASCADE
);


-- =============================================================================
-- OBSERVATION VERSIONS
-- =============================================================================

CREATE TABLE observation_versions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    observation_id INTEGER NOT NULL,
    version_num    INTEGER NOT NULL,
    content        TEXT    NOT NULL,
    weight         TEXT,
    emotion        TEXT,
    edited_at      TEXT    DEFAULT (datetime('now')),
    FOREIGN KEY (observation_id) REFERENCES observations(id) ON DELETE CASCADE
);


-- =============================================================================
-- IMAGES
-- =============================================================================

CREATE TABLE images (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    path             TEXT    NOT NULL,
    description      TEXT    NOT NULL,
    context          TEXT,
    emotion          TEXT,
    weight           TEXT    DEFAULT 'medium',
    entity_id        INTEGER,
    observation_id   INTEGER,
    charge           TEXT    DEFAULT 'fresh',
    created_at       TEXT    DEFAULT (datetime('now')),
    last_viewed_at   TEXT,
    view_count       INTEGER DEFAULT 0,
    novelty_score    REAL    DEFAULT 1.0,
    last_surfaced_at TEXT,
    surface_count    INTEGER DEFAULT 0,
    FOREIGN KEY (entity_id)      REFERENCES entities(id)      ON DELETE SET NULL,
    FOREIGN KEY (observation_id) REFERENCES observations(id)  ON DELETE SET NULL
);


-- =============================================================================
-- INDEXES
-- =============================================================================

-- Entities
CREATE INDEX idx_entities_name     ON entities(name);
CREATE INDEX idx_entities_type     ON entities(entity_type);
CREATE INDEX idx_entities_salience ON entities(salience);

-- Observations
CREATE INDEX idx_observations_entity        ON observations(entity_id);
CREATE INDEX idx_observations_charge        ON observations(charge);
CREATE INDEX idx_observations_weight_charge ON observations(weight, charge);
CREATE INDEX idx_observations_context       ON observations(context);
CREATE INDEX idx_observations_last_surfaced ON observations(last_surfaced_at);
CREATE INDEX idx_observations_novelty       ON observations(novelty_score);
CREATE INDEX idx_observations_surface_count ON observations(surface_count);
CREATE INDEX idx_observations_certainty     ON observations(certainty);
CREATE INDEX idx_observations_source        ON observations(source);
CREATE INDEX idx_observations_archived      ON observations(archived_at);

-- Threads / Context
CREATE INDEX idx_threads_status    ON threads(status);
CREATE INDEX idx_context_scope     ON context_entries(scope);
CREATE INDEX idx_relational_person ON relational_state(person);

-- Identity
CREATE INDEX idx_identity_section ON identity(section);

-- Journals / Notes
CREATE INDEX idx_journals_date        ON journals(entry_date);
CREATE INDEX idx_notes_context        ON notes(context);
CREATE INDEX idx_notes_charge         ON notes(charge);
CREATE INDEX idx_notes_weight_charge  ON notes(weight, charge);
CREATE INDEX idx_note_sits_note       ON note_sits(note_id);
CREATE INDEX idx_observation_sits_obs ON observation_sits(observation_id);

-- Vault / Sessions
CREATE INDEX idx_vault_source  ON vault_chunks(source_file);
CREATE INDEX idx_vault_era     ON vault_chunks(era);
CREATE INDEX idx_session_path  ON session_chunks(session_path);
CREATE INDEX idx_session_date  ON session_chunks(session_date);

-- Subconscious / Consolidation
CREATE INDEX idx_subconscious_type     ON subconscious(state_type);
CREATE INDEX idx_consolidation_status  ON consolidation_candidates(status);

-- Tensions
CREATE INDEX idx_tensions_status  ON tensions(resolved_at);
CREATE INDEX idx_tensions_created ON tensions(created_at DESC);

-- Living Surface
CREATE INDEX idx_co_surfacing_count      ON co_surfacing(co_count DESC);
CREATE INDEX idx_co_surfacing_obs_a      ON co_surfacing(obs_a_id);
CREATE INDEX idx_co_surfacing_obs_b      ON co_surfacing(obs_b_id);
CREATE INDEX idx_daemon_proposals_status ON daemon_proposals(status);
CREATE INDEX idx_orphan_observations_obs ON orphan_observations(observation_id);

-- Observation Versions
CREATE INDEX idx_observation_versions_obs ON observation_versions(observation_id);
CREATE INDEX idx_observation_versions_num ON observation_versions(observation_id, version_num DESC);

-- Images
CREATE INDEX idx_images_entity        ON images(entity_id);
CREATE INDEX idx_images_emotion       ON images(emotion);
CREATE INDEX idx_images_weight        ON images(weight);
CREATE INDEX idx_images_charge        ON images(charge);
CREATE INDEX idx_images_novelty       ON images(novelty_score);
CREATE INDEX idx_images_last_surfaced ON images(last_surfaced_at);
