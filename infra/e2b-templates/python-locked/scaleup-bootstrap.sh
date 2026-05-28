#!/usr/bin/env bash
#
# Bootstrap for scaleup-python-locked — see node-locked/scaleup-bootstrap.sh
# for rationale. Fails closed if egress lockdown can't be applied.

set -euo pipefail

LOGFILE=/var/log/scaleup-bootstrap.log
exec > >(tee -a "$LOGFILE") 2>&1

echo "[scaleup-bootstrap/python] $(date -Iseconds) starting"

if ! /usr/local/bin/whitelist-egress.sh; then
  echo "[scaleup-bootstrap/python] FATAL: egress whitelist failed"
  exit 1
fi

mkdir -p /var/lib/scaleup
echo "$(date -Iseconds)" > /var/lib/scaleup/egress-locked

exec sleep infinity
