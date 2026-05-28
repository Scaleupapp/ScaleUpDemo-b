# OpenJDK 21 + Maven capstone sandbox with whitelist-only egress.
# Anti-cheat: only Maven Central + sonatype + github reachable.
FROM e2bdev/code-interpreter:latest

RUN apt-get update && apt-get install -y \
    iptables \
    iptables-persistent \
    dnsutils \
    curl \
    openjdk-21-jdk-headless \
    maven \
 && rm -rf /var/lib/apt/lists/*

COPY scaleup-bootstrap.sh /usr/local/bin/scaleup-bootstrap.sh
COPY whitelist-egress.sh   /usr/local/bin/whitelist-egress.sh
RUN chmod +x /usr/local/bin/scaleup-bootstrap.sh /usr/local/bin/whitelist-egress.sh

# Pre-seed an offline-friendly settings.xml so Maven only talks to Central
# and the configured mirrors. This nudges builds away from random repos
# that wouldn't be reachable anyway under the egress whitelist.
RUN mkdir -p /root/.m2 && cat > /root/.m2/settings.xml <<'EOF'
<settings xmlns="http://maven.apache.org/SETTINGS/1.0.0">
  <mirrors>
    <mirror>
      <id>central-mirror</id>
      <mirrorOf>*</mirrorOf>
      <url>https://repo.maven.apache.org/maven2</url>
    </mirror>
  </mirrors>
</settings>
EOF

WORKDIR /home/user
