-- CarbBook schema v1 (spec §3). Synced tables share id/updated_at/updated_by/deleted/server_seq.

CREATE TABLE seq_counter (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  value INTEGER NOT NULL
);
INSERT INTO seq_counter (id, value) VALUES (1, 0);

CREATE TABLE food (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  brand TEXT,
  source TEXT NOT NULL CHECK (source IN ('usda', 'off', 'custom')),
  source_ref TEXT,
  derived_from TEXT,
  carbs_per_100g REAL,
  fiber_per_100g REAL,
  density_g_per_ml REAL,
  notes TEXT,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_seq INTEGER NOT NULL
);
CREATE INDEX food_server_seq ON food (server_seq);

CREATE TABLE portion (
  id TEXT PRIMARY KEY,
  food_id TEXT NOT NULL,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('volume', 'count', 'serving')),
  quantity REAL NOT NULL,
  grams REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_seq INTEGER NOT NULL
);
CREATE INDEX portion_server_seq ON portion (server_seq);
CREATE INDEX portion_food ON portion (food_id);

CREATE TABLE barcode (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  food_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_seq INTEGER NOT NULL
);
CREATE INDEX barcode_server_seq ON barcode (server_seq);
CREATE INDEX barcode_code ON barcode (code);

CREATE TABLE meal (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  yield_servings REAL NOT NULL DEFAULT 1,
  total_weight_g REAL,
  notes TEXT,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_seq INTEGER NOT NULL
);
CREATE INDEX meal_server_seq ON meal (server_seq);

CREATE TABLE meal_item (
  id TEXT PRIMARY KEY,
  meal_id TEXT NOT NULL,
  ref_type TEXT NOT NULL CHECK (ref_type IN ('food', 'meal')),
  ref_id TEXT NOT NULL,
  amount REAL NOT NULL,
  unit TEXT NOT NULL,
  position INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_seq INTEGER NOT NULL
);
CREATE INDEX meal_item_server_seq ON meal_item (server_seq);
CREATE INDEX meal_item_meal ON meal_item (meal_id);

CREATE TABLE log_entry (
  id TEXT PRIMARY KEY,
  eaten_at INTEGER NOT NULL,
  window_name TEXT,
  bg_mgdl REAL,
  bg_source TEXT NOT NULL CHECK (bg_source IN ('dexcom', 'manual', 'none')),
  bg_trend TEXT,
  total_carbs_g REAL NOT NULL,
  suggested_units REAL,
  taken_units REAL,
  settings_version_id TEXT,
  notes TEXT,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_seq INTEGER NOT NULL
);
CREATE INDEX log_entry_server_seq ON log_entry (server_seq);
CREATE INDEX log_entry_eaten_at ON log_entry (eaten_at);

CREATE TABLE log_item (
  id TEXT PRIMARY KEY,
  log_entry_id TEXT NOT NULL,
  ref_type TEXT NOT NULL CHECK (ref_type IN ('food', 'meal')),
  ref_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  amount REAL NOT NULL,
  unit TEXT NOT NULL,
  carbs_g REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_seq INTEGER NOT NULL
);
CREATE INDEX log_item_server_seq ON log_item (server_seq);
CREATE INDEX log_item_entry ON log_item (log_entry_id);
CREATE INDEX log_item_ref ON log_item (ref_id);

-- windows/correction/rounding hold JSON text; the sync layer (de)serializes them.
CREATE TABLE dose_settings (
  id TEXT PRIMARY KEY,
  effective_from INTEGER NOT NULL,
  windows TEXT NOT NULL,
  correction TEXT NOT NULL,
  rounding TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  server_seq INTEGER NOT NULL
);
CREATE INDEX dose_settings_server_seq ON dose_settings (server_seq);

-- Server-only tables (not synced).
CREATE TABLE user (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'viewer')),
  created_at INTEGER NOT NULL
);

-- id = sha256(token) hex; the raw token is only ever held by the client.
CREATE TABLE auth_session (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES user (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('cookie', 'bearer')),
  label TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX auth_session_user ON auth_session (user_id);
