# Any-unit foods — spec addendum

Date: 2026-09-14. User decision: labels that give carbs per cup/tbsp/piece without a weight must be enterable.
Amends spec §3 (food, portion) and §4.1–4.2.

## Data model
- `food.carbs_per_100ml` — new, nullable, finite 0..150. Volume carb basis.
- `portion.grams` — now nullable (finite > 0 when set).
- `portion.carbs_g` — new, nullable, finite 0..500. Carbs for `quantity` of that portion.
- Validation: a portion needs `grams` or `carbs_g` (or both). `kind: 'volume'` portions still require `grams` (a volume carb label is stored as `food.carbs_per_100ml`, not a portion).
- Existing rows are unchanged; all existing vectors keep their expectations.

## Label entry
- "Amount + unit = N g carbs", unit ∈ g, ml/l/tsp/tbsp/floz/cup, or a named piece/serving.
- g → `carbs_per_100g = N / amount_g × 100`.
- volume → `carbs_per_100ml = N / amount_ml × 100`.
- piece/serving → portion `{kind: 'count'|'serving', label, quantity, grams: <optional>, carbs_g: N}`.
- Optional weight, if the label also gives it, is stored as before (enables grams).

## Carb math (core, TS + Swift identical)
Direct basis wins for its unit family; conversion through density is the fallback.
- Mass unit → `carbs_per_100g` if valid; else `carbs_per_100ml` + density; else incomplete.
- Volume unit → `carbs_per_100ml` if valid; else `carbs_per_100g` + density; else incomplete.
- `p:<id>` → `portion.carbs_g` if valid (`amount / quantity × carbs_g`); else `grams` via the mass path; else incomplete.
- `foodAmountToGrams` unchanged (null when a weight isn't known).

## Unit lists
- Mass units: listed when a mass path exists (`carbs_per_100g` valid, or `carbs_per_100ml` valid + density), or when the food has no carb basis at all (so legacy incomplete foods still show "missing data").
- Volume units: listed when `carbs_per_100ml` valid, or density known (existing rule).
- Portion units: count/serving portions listed when `carbs_g` valid or `grams` valid.

## Unaffected
Dose estimate, limits, sync LWW, meals (meal `total_weight_g` still grams).
