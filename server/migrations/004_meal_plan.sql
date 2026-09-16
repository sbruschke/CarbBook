-- Meal planning (docs/superpowers/specs/2026-09-16-meal-planning-design.md §2): plan_entry and
-- plan_item. Nothing existing is altered -- the per-window carb goals live inside the existing
-- dose_settings.windows JSON column, so there is no column change and no data rewrite. Both
-- CREATEs run inside the migration runner's transaction (server/src/db.ts), so any failure in
-- this file rolls the whole file back and leaves user_version at 3.

-- Deploy guard: a hand-applied or partially restored schema could already hold these tables.
-- Abort with a readable message instead of an opaque "table plan_entry already exists".
CREATE TEMP TABLE migration_004_guard (existing INTEGER NOT NULL);
CREATE TEMP TRIGGER migration_004_guard_check BEFORE INSERT ON migration_004_guard
  WHEN NEW.existing > 0
  BEGIN
    SELECT RAISE(ABORT, 'migration 004: plan_entry/plan_item already exist; drop them (or restore a clean backup) before upgrading');
  END;
INSERT INTO migration_004_guard (existing)
  SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name IN ('plan_entry', 'plan_item');
DROP TRIGGER migration_004_guard_check;
DROP TABLE migration_004_guard;

-- log_entry_id is deliberately NOT a REFERENCES column: sync is offline-first and a plan entry may
-- arrive before the log entry it points at (same reasoning as log_item.ref_id, see sync/tables.ts).
-- The push layer checks the reference instead, where it can reject the record rather than the batch.
CREATE TABLE plan_entry (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  window_name TEXT NOT NULL CHECK (length(window_name) BETWEEN 1 AND 64),
  status TEXT NOT NULL CHECK (status IN ('planned', 'logged', 'skipped')),
  note TEXT,
  log_entry_id TEXT,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_seq INTEGER NOT NULL
);
CREATE INDEX plan_entry_server_seq ON plan_entry (server_seq);
CREATE INDEX plan_entry_date ON plan_entry (date);
CREATE INDEX plan_entry_log_entry ON plan_entry (log_entry_id);
-- At most one non-deleted entry per (date, window_name); soft-deleted rows free the slot again.
CREATE UNIQUE INDEX plan_entry_slot ON plan_entry (date, window_name) WHERE deleted = 0;

CREATE TABLE plan_item (
  id TEXT PRIMARY KEY,
  plan_entry_id TEXT NOT NULL,
  ref_type TEXT NOT NULL CHECK (ref_type IN ('food', 'meal')),
  ref_id TEXT NOT NULL,
  amount REAL NOT NULL CHECK (amount >= 0),
  unit TEXT NOT NULL,
  position INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_seq INTEGER NOT NULL
);
CREATE INDEX plan_item_server_seq ON plan_item (server_seq);
CREATE INDEX plan_item_entry ON plan_item (plan_entry_id);
