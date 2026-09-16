-- Quick carbs rows (docs/superpowers/specs/2026-09-16-quick-carbs-design.md §2): ref_type 'quick' on
-- meal_item, log_item and plan_item, and a nullable label on meal_item and plan_item. SQLite cannot
-- change a CHECK in place, so the three tables are rebuilt with every row, server_seq value and index
-- kept (the 003 pattern). The runner (server/src/db.ts) wraps this file in one transaction: any
-- failure below rolls the whole file back and leaves user_version at 4.

-- Deploy guard: refuse unexpected data instead of failing on an opaque CHECK or silently changing it.
CREATE TEMP TABLE migration_005_guard (problems INTEGER NOT NULL);
CREATE TEMP TRIGGER migration_005_guard_check BEFORE INSERT ON migration_005_guard
  WHEN NEW.problems > 0
  BEGIN
    SELECT RAISE(ABORT, 'migration 005: unexpected item data (ref_type other than food/meal, a negative plan_item amount, or a label column that already exists); inspect meal_item, log_item and plan_item before upgrading');
  END;
INSERT INTO migration_005_guard (problems) SELECT
    (SELECT count(*) FROM meal_item WHERE ref_type NOT IN ('food', 'meal'))
  + (SELECT count(*) FROM log_item WHERE ref_type NOT IN ('food', 'meal'))
  + (SELECT count(*) FROM plan_item WHERE ref_type NOT IN ('food', 'meal') OR amount < 0)
  + (SELECT count(*) FROM pragma_table_info('meal_item') WHERE name = 'label')
  + (SELECT count(*) FROM pragma_table_info('plan_item') WHERE name = 'label');
DROP TRIGGER migration_005_guard_check;
DROP TABLE migration_005_guard;

-- Row counts before the rebuild; compared with the rebuilt tables at the end.
CREATE TEMP TABLE migration_005_before AS SELECT
  (SELECT count(*) FROM meal_item) AS meal_items,
  (SELECT count(*) FROM log_item) AS log_items,
  (SELECT count(*) FROM plan_item) AS plan_items;

-- meal_item
CREATE TABLE meal_item_new (
  id TEXT PRIMARY KEY,
  meal_id TEXT NOT NULL,
  ref_type TEXT NOT NULL CHECK (ref_type IN ('food', 'meal', 'quick')),
  ref_id TEXT NOT NULL,
  amount REAL NOT NULL,
  unit TEXT NOT NULL,
  position INTEGER NOT NULL,
  label TEXT CHECK (label IS NULL OR length(label) <= 80),
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_seq INTEGER NOT NULL,
  CHECK (ref_type <> 'quick' OR (unit = 'carbs' AND amount >= 0 AND amount <= 2000)),
  CHECK (ref_type = 'quick' OR label IS NULL)
);
INSERT INTO meal_item_new (id, meal_id, ref_type, ref_id, amount, unit, position, label, updated_at, updated_by, deleted, server_seq)
  SELECT id, meal_id, ref_type, ref_id, amount, unit, position, NULL, updated_at, updated_by, deleted, server_seq FROM meal_item;
DROP TABLE meal_item;
ALTER TABLE meal_item_new RENAME TO meal_item;
CREATE INDEX meal_item_server_seq ON meal_item (server_seq);
CREATE INDEX meal_item_meal ON meal_item (meal_id);

-- log_item (no label: display_name already carries it; carbs_g must equal amount for quick rows)
CREATE TABLE log_item_new (
  id TEXT PRIMARY KEY,
  log_entry_id TEXT NOT NULL,
  ref_type TEXT NOT NULL CHECK (ref_type IN ('food', 'meal', 'quick')),
  ref_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  amount REAL NOT NULL,
  unit TEXT NOT NULL,
  carbs_g REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_seq INTEGER NOT NULL,
  CHECK (ref_type <> 'quick' OR (unit = 'carbs' AND amount >= 0 AND amount <= 2000 AND carbs_g = amount))
);
INSERT INTO log_item_new (id, log_entry_id, ref_type, ref_id, display_name, amount, unit, carbs_g, updated_at, updated_by, deleted, server_seq)
  SELECT id, log_entry_id, ref_type, ref_id, display_name, amount, unit, carbs_g, updated_at, updated_by, deleted, server_seq FROM log_item;
DROP TABLE log_item;
ALTER TABLE log_item_new RENAME TO log_item;
CREATE INDEX log_item_server_seq ON log_item (server_seq);
CREATE INDEX log_item_entry ON log_item (log_entry_id);
CREATE INDEX log_item_ref ON log_item (ref_id);

-- plan_item
CREATE TABLE plan_item_new (
  id TEXT PRIMARY KEY,
  plan_entry_id TEXT NOT NULL,
  ref_type TEXT NOT NULL CHECK (ref_type IN ('food', 'meal', 'quick')),
  ref_id TEXT NOT NULL,
  amount REAL NOT NULL CHECK (amount >= 0),
  unit TEXT NOT NULL,
  position INTEGER NOT NULL,
  label TEXT CHECK (label IS NULL OR length(label) <= 80),
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_seq INTEGER NOT NULL,
  CHECK (ref_type <> 'quick' OR (unit = 'carbs' AND amount <= 2000)),
  CHECK (ref_type = 'quick' OR label IS NULL)
);
INSERT INTO plan_item_new (id, plan_entry_id, ref_type, ref_id, amount, unit, position, label, updated_at, updated_by, deleted, server_seq)
  SELECT id, plan_entry_id, ref_type, ref_id, amount, unit, position, NULL, updated_at, updated_by, deleted, server_seq FROM plan_item;
DROP TABLE plan_item;
ALTER TABLE plan_item_new RENAME TO plan_item;
CREATE INDEX plan_item_server_seq ON plan_item (server_seq);
CREATE INDEX plan_item_entry ON plan_item (plan_entry_id);

-- Every row survived the rebuild.
CREATE TEMP TABLE migration_005_after (lost INTEGER NOT NULL);
CREATE TEMP TRIGGER migration_005_after_check BEFORE INSERT ON migration_005_after
  WHEN NEW.lost <> 0
  BEGIN
    SELECT RAISE(ABORT, 'migration 005: row counts changed during the item table rebuild');
  END;
INSERT INTO migration_005_after (lost) SELECT
    abs((SELECT count(*) FROM meal_item) - b.meal_items)
  + abs((SELECT count(*) FROM log_item) - b.log_items)
  + abs((SELECT count(*) FROM plan_item) - b.plan_items)
  FROM migration_005_before AS b;
DROP TRIGGER migration_005_after_check;
DROP TABLE migration_005_after;
DROP TABLE migration_005_before;
