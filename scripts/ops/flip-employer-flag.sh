#!/usr/bin/env bash
#
# Flip the "Hire from ScaleUp" employer-marketplace flag in the server's .env and restart
# pm2 so the app re-reads it (server.js loads dotenv at boot).
#
#   FEATURE_EMPLOYER_MARKETPLACE — when off (default) every employer/talent route 404s
#                                  (the feature is invisible: apps self-gate, web is unlinked).
#                                  When on, the candidate consent + employer search/connection
#                                  endpoints go live. VERIFIED backward-compatible: only the
#                                  new employer/talent files read this flag — no existing
#                                  endpoint changes behaviour.
#
# Usage (run from the backend project root, e.g. via the Run-DB-Migration workflow):
#   bash scripts/ops/flip-employer-flag.sh on     # activate the marketplace endpoints
#   bash scripts/ops/flip-employer-flag.sh off    # instant rollback
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
sed -i '/^FEATURE_EMPLOYER_MARKETPLACE=/d' "$ENV_FILE"
echo "FEATURE_EMPLOYER_MARKETPLACE=$VAL" >> "$ENV_FILE"

echo "=== employer-marketplace flag now ($MODE) ==="
grep -E '^FEATURE_EMPLOYER_MARKETPLACE=' "$ENV_FILE"

# Restart so the new process re-runs dotenv.config() and picks up the change.
pm2 restart all --update-env
echo "=== pm2 ==="
pm2 list
echo "=== flip $MODE complete ==="
