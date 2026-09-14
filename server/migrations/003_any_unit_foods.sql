-- Any-unit foods addendum (docs/superpowers/specs/2026-09-14-any-unit-foods.md):
-- food.carbs_per_100ml (volume carb basis) and portion.carbs_g (carbs for `quantity` of a
-- portion), with portion.grams now nullable. SQLite cannot ALTER a column's NOT NULL/CHECK
-- in place, so the portion table is rebuilt, preserving rows, server_seq values and indexes.

ALTER TABLE food ADD COLUMN carbs_per_100ml REAL CHECK (carbs_per_100ml IS NULL OR (carbs_per_100ml >= 0 AND carbs_per_100ml <= 150));

CREATE TABLE portion_new (
  id TEXT PRIMARY KEY,
  food_id TEXT NOT NULL,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('volume', 'count', 'serving')),
  quantity REAL NOT NULL,
  grams REAL,
  carbs_g REAL CHECK (carbs_g IS NULL OR (carbs_g >= 0 AND carbs_g <= 500)),
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_seq INTEGER NOT NULL,
  CHECK (grams IS NULL OR grams > 0),
  CHECK (grams IS NOT NULL OR carbs_g IS NOT NULL),
  CHECK (kind <> 'volume' OR grams IS NOT NULL)
);

INSERT INTO portion_new (id, food_id, label, kind, quantity, grams, carbs_g, updated_at, updated_by, deleted, server_seq)
  SELECT id, food_id, label, kind, quantity, grams, NULL, updated_at, updated_by, deleted, server_seq FROM portion;

DROP TABLE portion;
ALTER TABLE portion_new RENAME TO portion;

CREATE INDEX portion_server_seq ON portion (server_seq);
CREATE INDEX portion_food ON portion (food_id);
