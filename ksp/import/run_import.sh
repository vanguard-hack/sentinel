#!/usr/bin/env bash
#
# Bulk-import every ksp/*.csv into its Catalyst Data Store table via `ds:import --config`.
#
# PREREQUISITES (one-time):
#   1. Create every table listed in SCHEMA.md in the Catalyst console
#      (Data Store -> New Table). Table name must equal the CSV filename (no .csv).
#   2. A Stratus bucket named "$CATALYST_BUCKET" must exist (default: accused).
#      Regenerate configs against a different bucket with:
#         CATALYST_BUCKET=<bucket> python3 prepare_import.py
#
# USAGE:
#   ./run_import.sh                # dev environment
#   ./run_import.sh --production   # production environment (no 5k row cap)
#   ./run_import.sh victims fir    # only the named tables
#
set -uo pipefail
cd "$(dirname "$0")"

PROD_FLAG=""
TABLES=()
for arg in "$@"; do
  if [[ "$arg" == "--production" ]]; then PROD_FLAG="--production"; else TABLES+=("$arg"); fi
done

# If no tables named, do all of them.
if [[ ${#TABLES[@]} -eq 0 ]]; then
  for f in configs/*.json; do TABLES+=("$(basename "$f" .json)"); done
fi

DEV_LIMIT=5000
fail=0

for table in "${TABLES[@]}"; do
  cfg="configs/${table}.json"
  csv="../${table}.csv"
  if [[ ! -f "$cfg" ]]; then echo "SKIP  $table (no config)"; continue; fi

  rows=$(( $(wc -l < "$csv") - 1 ))
  if [[ -z "$PROD_FLAG" && $rows -gt $DEV_LIMIT ]]; then
    echo "WARN  $table has $rows rows > $DEV_LIMIT dev cap — split it or use --production."
    echo "      To split:  tail -n +2 $csv | split -l $DEV_LIMIT - ${table}_part_"
    echo "      then prepend the header to each part and make a config per part."
    fail=1
    continue
  fi

  echo "----> importing $table ($rows rows)"
  out=$(catalyst ds:import --config "$cfg" $PROD_FLAG 2>&1)
  echo "$out"
  # Surface the job id if the CLI printed one; poll its final status.
  jobid=$(echo "$out" | grep -oiE 'job[_ ]?id[^0-9]*[0-9]{8,}' | grep -oE '[0-9]{8,}' | head -1)
  if [[ -n "$jobid" ]]; then
    echo "      job $jobid — checking status"
    catalyst ds:status import "$jobid" $PROD_FLAG 2>&1 | tail -5
  fi
  if echo "$out" | grep -qiE 'error|✖'; then fail=1; fi
  echo
done

if [[ $fail -ne 0 ]]; then
  echo "Done with some warnings/errors — review output above."
  exit 1
fi
echo "All imports submitted successfully."
