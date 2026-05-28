#!/usr/bin/env bash
#
# Egress whitelist for the java capstone sandbox.
# DROP-by-default; allow DNS + Maven Central + github.

set -euo pipefail

iptables -F OUTPUT
iptables -P OUTPUT DROP

iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT

ALLOWED_HOSTS=(
  "repo.maven.apache.org"
  "repo1.maven.org"
  "maven.apache.org"
  "oss.sonatype.org"
  "s01.oss.sonatype.org"
  "repository.sonatype.org"
  "github.com"
  "objects.githubusercontent.com"
  "codeload.github.com"
  "raw.githubusercontent.com"
)

for host in "${ALLOWED_HOSTS[@]}"; do
  for ip in $(dig +short "$host" A | grep -E '^[0-9]'); do
    iptables -A OUTPUT -p tcp -d "$ip" --dport 443 -j ACCEPT
    iptables -A OUTPUT -p tcp -d "$ip" --dport 80  -j ACCEPT
  done
done

echo "[scaleup-egress/java] OUTPUT policy: DROP except DNS + ${#ALLOWED_HOSTS[@]} whitelisted hosts"
