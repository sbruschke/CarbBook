#!/usr/bin/env bash
# Download the FoodData Central CSVs, import them into carbs-server and build the client bundles.
# Runs on the Pi. Set KEEP_SRC=1 to keep the downloaded/extracted files.
set -euo pipefail

WORK=/opt/carbbook/data/usda-src          # visible in the container as /data/usda-src
NEED_MB=1500
DATASETS=(
  FoodData_Central_foundation_food_csv_2026-04-30
  FoodData_Central_sr_legacy_food_csv_2018-04
  FoodData_Central_survey_food_csv_2024-10-31
)

FREE_MB=$(df -Pm /opt/carbbook | awk 'NR==2 {print $4}')
if [ "$FREE_MB" -lt "$NEED_MB" ]; then
  echo "only ${FREE_MB} MB free on /opt/carbbook; need ${NEED_MB} MB" >&2
  exit 1
fi
docker inspect -f '{{.State.Health.Status}}' carbs-server | grep -qx healthy \
  || { echo "carbs-server is not healthy" >&2; exit 1; }

mkdir -p "$WORK"
cd "$WORK"
for z in "${DATASETS[@]}"; do
  [ -f "$z.zip" ] || curl -sSfL -o "$z.zip" "https://fdc.nal.usda.gov/fdc-datasets/$z.zip"
  [ -d "$z" ] || unzip -q "$z.zip"
  test -f "$z/food.csv" -a -f "$z/food_nutrient.csv" -a -f "$z/food_portion.csv" -a -f "$z/measure_unit.csv" \
    || { echo "$z is missing expected CSV files" >&2; exit 1; }
done
echo "downloaded+extracted: $(du -sh "$WORK" | cut -f1); free now $(df -Pm /opt/carbbook | awk 'NR==2 {print $4}') MB"

docker exec carbs-server carbbook import-usda "${DATASETS[@]/#//data/usda-src/}"
ls -l /opt/carbbook/data/usda

if [ "${KEEP_SRC:-0}" != 1 ]; then
  rm -rf "$WORK"
  echo "removed $WORK"
fi
