#!/usr/bin/env bash
#
# Flip the readiness-redesign feature flags in the server's .env and restart pm2
# so the app re-reads them (server.js loads dotenv at boot).
#
#   FEATURE_COMPOSITE_READINESS  — serve the multi-primitive composite (guardrail
#                                  still falls back to legacy when confidence is low)
#   FEATURE_OBJECTIVE_TARGET     — serve the computed per-objective target instead
#                                  of flat-80 (falls back to 80 when no analysis)
#
# Usage (run from the backend project root, e.g. via the Run-DB-Migration workflow):
#   bash scripts/ops/flip-readiness-flags.sh on     # activate the redesign
#   bash scripts/ops/flip-readiness-flags.sh off    # instant rollback
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

# Remove any existing definitions, then append the desired value.
sed -i '/^FEATURE_COMPOSITE_READINESS=/d;/^FEATURE_OBJECTIVE_TARGET=/d' "$ENV_FILE"
{
  echo "FEATURE_COMPOSITE_READINESS=$VAL"
  echo "FEATURE_OBJECTIVE_TARGET=$VAL"
} >> "$ENV_FILE"

echo "=== readiness flags now ($MODE) ==="
grep -E '^FEATURE_(COMPOSITE_READINESS|OBJECTIVE_TARGET)=' "$ENV_FILE"

# Restart so the new process re-runs dotenv.config() and picks up the change.
pm2 restart all --update-env
echo "=== pm2 ==="
pm2 list
echo "=== flip $MODE complete ==="
