-- USDA reference library (spec §6) and full-text search for foods, meals and USDA.

CREATE TABLE usda_food (
  fdc_id INTEGER PRIMARY KEY,
  data_type TEXT NOT NULL,
  name TEXT NOT NULL,
  carbs_per_100g REAL,
  fiber_per_100g REAL
);

-- id = FDC food_portion.id; label/kind follow core's PortionData rules.
CREATE TABLE usda_portion (
  id INTEGER PRIMARY KEY,
  fdc_id INTEGER NOT NULL REFERENCES usda_food (fdc_id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('volume', 'count', 'serving')),
  quantity REAL NOT NULL,
  grams REAL NOT NULL,
  description TEXT NOT NULL
);
CREATE INDEX usda_portion_fdc ON usda_portion (fdc_id);

-- External-content index; rebuilt after each import.
CREATE VIRTUAL TABLE usda_fts USING fts5 (
  name,
  content = 'usda_food',
  content_rowid = 'fdc_id',
  tokenize = 'unicode61 remove_diacritics 2'
);

-- User library (food + meal), kept current by triggers.
CREATE VIRTUAL TABLE catalog_fts USING fts5 (
  kind UNINDEXED,
  ref_id UNINDEXED,
  name,
  brand,
  tokenize = 'unicode61 remove_diacritics 2'
);

INSERT INTO catalog_fts (kind, ref_id, name, brand)
  SELECT 'food', id, name, coalesce(brand, '') FROM food WHERE deleted = 0;
INSERT INTO catalog_fts (kind, ref_id, name, brand)
  SELECT 'meal', id, name, '' FROM meal WHERE deleted = 0;

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
  INSERT INTO catalog_fts (kind, ref_id, name, brand)
    SELECT 'meal', new.id, new.name, '' WHERE new.deleted = 0;
END;
