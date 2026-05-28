# Node 20 capstone sandbox with whitelist-only egress.
# Anti-cheat: only registry.npmjs.org + a small set of mirrors reachable.
FROM e2bdev/code-interpreter:latest

RUN apt-get update && apt-get install -y \
    iptables \
    iptables-persistent \
    dnsutils \
    curl \
 && rm -rf /var/lib/apt/lists/*

# Install Node 20 LTS
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y nodejs \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g npm@latest

# Egress lockdown script — runs at container start so the rules are fresh.
COPY scaleup-bootstrap.sh /usr/local/bin/scaleup-bootstrap.sh
COPY whitelist-egress.sh   /usr/local/bin/whitelist-egress.sh
RUN chmod +x /usr/local/bin/scaleup-bootstrap.sh /usr/local/bin/whitelist-egress.sh

WORKDIR /home/user
