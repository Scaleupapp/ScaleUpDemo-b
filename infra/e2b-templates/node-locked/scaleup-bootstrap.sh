#!/usr/bin/env bash
#
# Bootstrap script for the scaleup-node-locked sandbox.
#
# Order matters:
#   1. Apply egress whitelist BEFORE the learner can touch the network.
#   2. Hand control back to e2b's default sandbox process (sleep infinity
#      keeps the container alive; e2b's control plane handles file ops
#      and process spawning via the SDK).
#
# If the egress script fails we fail closed — better to deny the sandbox
# from starting than to let it boot with unrestricted egress.

set -euo pipefail

LOGFILE=/var/log/scaleup-bootstrap.log
exec > >(tee -a "$LOGFILE") 2>&1

echo "[scaleup-bootstrap] $(date -Iseconds) starting"

if ! /usr/local/bin/whitelist-egress.sh; then
  echo "[scaleup-bootstrap] FATAL: egress whitelist failed — refusing to start"
  exit 1
fi

echo "[scaleup-bootstrap] egress locked; sandbox ready"

# Touch a marker file so the backend's sandbox-readiness probe can confirm
# the lockdown ran on this container instance.
mkdir -p /var/lib/scaleup
echo "$(date -Iseconds)" > /var/lib/scaleup/egress-locked

# Yield to long-running sleep — e2b's SDK drives the container from here.
exec sleep infinity
