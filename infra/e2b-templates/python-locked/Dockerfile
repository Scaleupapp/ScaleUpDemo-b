# Python 3.11 capstone sandbox with whitelist-only egress.
# Anti-cheat: only pypi.org / files.pythonhosted.org + github reachable.
FROM e2bdev/code-interpreter:latest

RUN apt-get update && apt-get install -y \
    iptables \
    iptables-persistent \
    dnsutils \
    curl \
    python3.11 \
    python3.11-venv \
    python3-pip \
 && rm -rf /var/lib/apt/lists/* \
 && ln -sf /usr/bin/python3.11 /usr/local/bin/python \
 && python -m pip install --upgrade pip

COPY scaleup-bootstrap.sh /usr/local/bin/scaleup-bootstrap.sh
COPY whitelist-egress.sh   /usr/local/bin/whitelist-egress.sh
RUN chmod +x /usr/local/bin/scaleup-bootstrap.sh /usr/local/bin/whitelist-egress.sh

WORKDIR /home/user
