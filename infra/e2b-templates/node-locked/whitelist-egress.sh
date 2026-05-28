#!/usr/bin/env bash
#
# Egress whitelist for the capstone sandbox.
#
# Policy:
#   - DROP all outbound by default.
#   - ALLOW DNS (UDP 53 + TCP 53) so resolves work.
#   - ALLOW outbound to the small list of registry hosts we need for
#     package installs.
#   - ALLOW localhost (so the learner can run a local server during tests).
#
# Anything else outbound (api.openai.com, api.anthropic.com,
# generic egress to arbitrary public hosts) is blocked. Compass-Coder
# calls go through the backend, not the sandbox, so this doesn't
# break the AI-pair.

set -euo pipefail

# Reset
iptables -F OUTPUT
iptables -P OUTPUT DROP

# Loopback always allowed
iptables -A OUTPUT -o lo -j ACCEPT

# Established connections (responses to inbound) — defensive; sandboxes
# don't usually have inbound listeners, but harmless.
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# DNS
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT

# Whitelisted hostnames — resolve at bootstrap so dynamic IPs are
# captured. We resolve through the in-container resolver (which is
# itself going to one of the resolvers above).
ALLOWED_HOSTS=(
  "registry.npmjs.org"
  "registry.yarnpkg.com"
  "registry.npmmirror.com"
  "deb.nodesource.com"
  "nodejs.org"
  "github.com"          # raw.githubusercontent.com falls under this — needed by some npm postinstalls
  "objects.githubusercontent.com"
  "codeload.github.com"
)

for host in "${ALLOWED_HOSTS[@]}"; do
  # Multiple A records possible; capture all.
  for ip in $(dig +short "$host" A | grep -E '^[0-9]'); do
    iptables -A OUTPUT -p tcp -d "$ip" --dport 443 -j ACCEPT
    iptables -A OUTPUT -p tcp -d "$ip" --dport 80  -j ACCEPT
  done
done

echo "[scaleup-egress] OUTPUT policy: DROP except DNS + ${#ALLOWED_HOSTS[@]} whitelisted hosts"
