import GRDB

/// Local SQLite schema: the synced tables with the server's column names (spec §3), the user
/// library search index, and client-only sync bookkeeping.
///
/// No foreign keys between synced tables: children may sync before their parents exist locally.
enum Schema {
    static var migrator: DatabaseMigrator {
        var migrator = DatabaseMigrator()
        migrator.registerMigration("v1") { db in
            try db.execute(sql: v1)
        }
        migrator.registerMigration("v2-any-unit-foods") { db in
            try db.execute(sql: v2AnyUnitFoods)
        }
        migrator.registerMigration("v3-meal-plan") { db in
            try db.execute(sql: v3MealPlan)
        }
        return migrator
    }

    /// Meal planning (spec §2). Mirrors server migration 004 minus the CHECKs the server enforces:
    /// the local database stores whatever the server sends, and a row the server would reject comes
    /// back as a `sync_rejection` instead of failing an INSERT here. No foreign keys, like every other
    /// synced table, and every reference column is nullable-safe (`note`, `log_entry_id`).
    /// No pull-cursor reset: these tables are new, so their rows arrive on the next ordinary pull.
    static let v3MealPlan = """
    CREATE TABLE plan_entry (
      id TEXT PRIMARY KEY, date TEXT NOT NULL, window_name TEXT NOT NULL, status TEXT NOT NULL,
      note TEXT, log_entry_id TEXT,
      updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, server_seq INTEGER
    );
    CREATE INDEX plan_entry_date ON plan_entry (date);
    CREATE INDEX plan_entry_log_entry ON plan_entry (log_entry_id);
    CREATE TABLE plan_item (
      id TEXT PRIMARY KEY, plan_entry_id TEXT NOT NULL, ref_type TEXT NOT NULL, ref_id TEXT NOT NULL,
      amount REAL NOT NULL, unit TEXT NOT NULL, position INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, server_seq INTEGER
    );
    CREATE INDEX plan_item_entry ON plan_item (plan_entry_id);
    CREATE INDEX plan_item_ref ON plan_item (ref_id);
    """

    /// Any-unit foods addendum: `food.carbs_per_100ml`, nullable `portion.grams`, `portion.carbs_g`.
    /// SQLite can't drop NOT NULL in place, so `portion` is rebuilt with every row copied (it has no
    /// triggers or foreign keys). Rows pulled before this migration may have lost the new server
    /// columns (the old schema had nowhere to put them, and a null-grams portion couldn't be stored at
    /// all), so the pull cursor restarts at 0: a full re-pull refreshes them (`shouldApplyPulled`
    /// re-applies an equal version; newer local edits still win). Rows that were pending at migration
    /// time were edited without knowledge of the new columns; `sync_legacy_pending` makes their push
    /// omit those keys (server keeps its stored values) until they are edited again.
    static let v2AnyUnitFoods = """
    ALTER TABLE food ADD COLUMN carbs_per_100ml REAL;
    CREATE TABLE portion_v2 (
      id TEXT PRIMARY KEY, food_id TEXT NOT NULL, label TEXT NOT NULL, kind TEXT NOT NULL,
      quantity REAL NOT NULL, grams REAL, carbs_g REAL,
      updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, server_seq INTEGER
    );
    INSERT INTO portion_v2 (id, food_id, label, kind, quantity, grams, carbs_g, updated_at, updated_by, deleted, server_seq)
      SELECT id, food_id, label, kind, quantity, grams, NULL, updated_at, updated_by, deleted, server_seq FROM portion;
    DROP TABLE portion;
    ALTER TABLE portion_v2 RENAME TO portion;
    CREATE INDEX portion_food ON portion (food_id);
    CREATE TABLE sync_legacy_pending (key TEXT PRIMARY KEY);
    INSERT INTO sync_legacy_pending (key) SELECT key FROM sync_pending WHERE table_name IN ('food', 'portion');
    UPDATE sync_state SET value = '0' WHERE key = 'pull_cursor';
    """

    static let v1 = """
    CREATE TABLE food (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, brand TEXT, source TEXT NOT NULL, source_ref TEXT,
      derived_from TEXT, carbs_per_100g REAL, fiber_per_100g REAL, density_g_per_ml REAL, notes TEXT,
      updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, server_seq INTEGER
    );
    CREATE INDEX food_source_ref ON food (source, source_ref);
    CREATE TABLE portion (
      id TEXT PRIMARY KEY, food_id TEXT NOT NULL, label TEXT NOT NULL, kind TEXT NOT NULL,
      quantity REAL NOT NULL, grams REAL NOT NULL,
      updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, server_seq INTEGER
    );
    CREATE INDEX portion_food ON portion (food_id);
    CREATE TABLE barcode (
      id TEXT PRIMARY KEY, code TEXT NOT NULL, food_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, server_seq INTEGER
    );
    CREATE INDEX barcode_code ON barcode (code);
    CREATE TABLE meal (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, yield_servings REAL NOT NULL DEFAULT 1, total_weight_g REAL, notes TEXT,
      updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, server_seq INTEGER
    );
    CREATE TABLE meal_item (
      id TEXT PRIMARY KEY, meal_id TEXT NOT NULL, ref_type TEXT NOT NULL, ref_id TEXT NOT NULL,
      amount REAL NOT NULL, unit TEXT NOT NULL, position INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, server_seq INTEGER
    );
    CREATE INDEX meal_item_meal ON meal_item (meal_id);
    CREATE TABLE log_entry (
      id TEXT PRIMARY KEY, eaten_at INTEGER NOT NULL, window_name TEXT, bg_mgdl REAL, bg_source TEXT NOT NULL,
      bg_trend TEXT, total_carbs_g REAL NOT NULL, suggested_units REAL, taken_units REAL, settings_version_id TEXT, notes TEXT,
      updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, server_seq INTEGER
    );
    CREATE INDEX log_entry_eaten_at ON log_entry (eaten_at);
    CREATE TABLE log_item (
      id TEXT PRIMARY KEY, log_entry_id TEXT NOT NULL, ref_type TEXT NOT NULL, ref_id TEXT NOT NULL,
      display_name TEXT NOT NULL, amount REAL NOT NULL, unit TEXT NOT NULL, carbs_g REAL NOT NULL,
      updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, server_seq INTEGER
    );
    CREATE INDEX log_item_entry ON log_item (log_entry_id);
    CREATE INDEX log_item_ref ON log_item (ref_id);
    CREATE TABLE dose_settings (
      id TEXT PRIMARY KEY, effective_from INTEGER NOT NULL, windows TEXT NOT NULL, correction TEXT NOT NULL, rounding TEXT NOT NULL,
      updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, server_seq INTEGER
    );

    -- User library search, kept current by triggers (same shape as the server's catalog_fts).
    CREATE VIRTUAL TABLE catalog_fts USING fts5 (
      kind UNINDEXED, ref_id UNINDEXED, name, brand, tokenize = 'unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER food_catalog_insert AFTER INSERT ON food WHEN new.deleted = 0 BEGIN
      INSERT INTO catalog_fts (kind, ref_id, name, brand) VALUES ('food', new.id, new.name, coalesce(new.brand, ''));
    END;
    CREATE TRIGGER food_catalog_update AFTER UPDATE ON food BEGIN
      DELETE FROM catalog_fts WHERE kind = 'food' AND ref_id = old.id;
      INSERT INTO catalog_fts (kind, ref_id, name, brand)
        SELECT 'food', new.id, new.name, coalesce(new.brand, '') WHERE new.deleted = 0;
    END;
    CREATE TRIGGER meal_catalog_insert AFTER INSERT ON meal WHEN new.deleted = 0 BEGIN
      INSERT INTO catalog_fts (kind, ref_id, name, brand) VALUES ('meal', new.id, new.name, '');
    END;
    CREATE TRIGGER meal_catalog_update AFTER UPDATE ON meal BEGIN
      DELETE FROM catalog_fts WHERE kind = 'meal' AND ref_id = old.id;
      INSERT INTO catalog_fts (kind, ref_id, name, brand) SELECT 'meal', new.id, new.name, '' WHERE new.deleted = 0;
    END;
    -- Hard deletes happen only when a never-synced row is rejected by the server.
    CREATE TRIGGER food_catalog_delete AFTER DELETE ON food BEGIN
      DELETE FROM catalog_fts WHERE kind = 'food' AND ref_id = old.id;
    END;
    CREATE TRIGGER meal_catalog_delete AFTER DELETE ON meal BEGIN
      DELETE FROM catalog_fts WHERE kind = 'meal' AND ref_id = old.id;
    END;

    -- Client-only sync bookkeeping (never pushed).
    CREATE TABLE sync_pending (
      key TEXT PRIMARY KEY, table_name TEXT NOT NULL, record_id TEXT NOT NULL, queued_at INTEGER NOT NULL
    );
    -- Last server-acknowledged copy (accepted push or applied pull) of each synced row, as the wire
    -- record JSON including server_seq. No row here means "never synced": a rejection deletes it.
    CREATE TABLE sync_snapshot (
      key TEXT PRIMARY KEY, table_name TEXT NOT NULL, record_id TEXT NOT NULL, record TEXT NOT NULL
    );
    CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    -- rejected_updated_at is the `updated_at` of the version that was rejected: it lets
    -- rejectedDoseSettingsIds() tell "restore failed, row is still stuck at the rejected version"
    -- (current row's updated_at still matches) from "restore succeeded" (it now differs), and a pull
    -- that later lands the same key clears the row (LocalSyncStore.applyPull).
    CREATE TABLE sync_rejection (
      key TEXT PRIMARY KEY, table_name TEXT NOT NULL, record_id TEXT NOT NULL, reason TEXT, message TEXT,
      rejected_at INTEGER NOT NULL, rejected_updated_at INTEGER
    );
    CREATE TABLE barcode_queue (code TEXT PRIMARY KEY, note TEXT, queued_at INTEGER NOT NULL);
    """
}
