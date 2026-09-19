-- Food and meal images (docs/superpowers/specs/2026-09-18-food-images-design.md).
-- Pure additions: a new synced metadata table plus a nullable image_id on food and meal.
-- No table rebuild is needed (unlike 003 and 005) because no CHECK constraint changes.
-- The runner (server/src/db.ts) wraps this file in one transaction.

-- Deploy guard: refuse to run twice or over a hand-added column.
CREATE TEMP TABLE migration_006_guard (problems INTEGER NOT NULL);
CREATE TEMP TRIGGER migration_006_guard_check BEFORE INSERT ON migration_006_guard
  WHEN NEW.problems > 0
  BEGIN
    SELECT RAISE(ABORT, 'migration 006: image table or an image_id column already exists; inspect the database before upgrading');
  END;
INSERT INTO migration_006_guard (problems) SELECT
    (SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'image')
  + (SELECT count(*) FROM pragma_table_info('food') WHERE name = 'image_id')
  + (SELECT count(*) FROM pragma_table_info('meal') WHERE name = 'image_id');
DROP TRIGGER migration_006_guard_check;
DROP TABLE migration_006_guard;

-- id = sha256 of the normalised bytes, lowercase hex. Bytes live on disk under IMAGE_DIR,
-- never in this database and never in sync payloads. Licence and attribution travel with the
-- row because a CC-BY image displayed without its credit line is a licence violation.
CREATE TABLE image (
  id TEXT PRIMARY KEY CHECK (length(id) = 64),
  mime TEXT NOT NULL CHECK (mime IN ('image/jpeg')),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  source TEXT NOT NULL CHECK (source IN ('off', 'openverse', 'wikimedia', 'themealdb', 'upload')),
  source_url TEXT,
  license TEXT,
  attribution TEXT,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_seq INTEGER NOT NULL
);
CREATE INDEX image_server_seq ON image (server_seq);

-- Not a foreign key: offline clients may push a food before its image row arrives, and a
-- dangling id must render as no image rather than fail the push (tables.ts:129-135).
ALTER TABLE food ADD COLUMN image_id TEXT;
ALTER TABLE meal ADD COLUMN image_id TEXT;
CREATE INDEX food_image ON food (image_id);
CREATE INDEX meal_image ON meal (image_id);
