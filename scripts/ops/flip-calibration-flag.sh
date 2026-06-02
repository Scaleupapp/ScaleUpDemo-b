#!/usr/bin/env bash
#
# Flip the Phase 4B outcome-calibrated-target flag in the server's .env and restart
# pm2 so the app re-reads it (server.js loads dotenv at boot).
#
#   FEATURE_OUTCOME_CALIBRATED_TARGET — serve the evidence-based calibrated target
#                                       (per archetype) when a sufficient CalibrationModel
#                                       exists; otherwise falls back to the P2 heuristic.
#
# SAFETY: with no CalibrationModel (the state until ~100 resolved outcomes/archetype
# accumulate AND scripts/jobs/recomputeCalibration.js is run), this is a NO-OP — every
# objective still gets the P2 heuristic target. Independent of the other readiness flags.
#
# Usage (run from the backend project root, e.g. via the Run-DB-Migration workflow):
#   bash scripts/ops/flip-calibration-flag.sh on     # serve calibrated targets when available
#   bash scripts/ops/flip-calibration-flag.sh off    # instant rollback to heuristic
#
set -euo pipefail

MODE="${1:-}"
if [ "$MODE" != "on" ] && [ "$MODE" != "off" ]; then
  echo "usage: $0 on|off"; exit 1
fi
if [ "$MODE" = "on" ]; then VAL=true; else VAL=false; fi

ENV_FILE=".env"
[ -f "$ENV_FILE" ] || { echo "ERROR: no .env in $(pwd)"; exit 1; }

# Keep the first pre-flip snapshot as a backup (no-clobber).
cp -n "$ENV_FILE" "$ENV_FILE.bak.preflip" 2>/dev/null || true

# Remove any existing definition, then append the desired value.
sed -i '/^FEATURE_OUTCOME_CALIBRATED_TARGET=/d' "$ENV_FILE"
echo "FEATURE_OUTCOME_CALIBRATED_TARGET=$VAL" >> "$ENV_FILE"

echo "=== calibration flag now ($MODE) ==="
grep -E '^FEATURE_OUTCOME_CALIBRATED_TARGET=' "$ENV_FILE"

# Restart so the new process re-runs dotenv.config() and picks up the change.
pm2 restart all --update-env
echo "=== pm2 ==="
pm2 list
echo "=== flip $MODE complete ==="
