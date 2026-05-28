# Custom e2b templates with egress lockdown

WS0 spike found that e2b's default templates allow full outbound network
access — a determined cheater could `curl` an external LLM from inside
the capstone sandbox. Spec §13.1 #2 mandates whitelist-only egress
(npm + pip + the small set of mirrors we need for package installs).

These templates ship with that lockdown baked in. Once built and pushed,
set the relevant env vars (E2B_TEMPLATE_PYTHON, E2B_TEMPLATE_NODE,
E2B_TEMPLATE_JAVA) on the backend so `sandboxOrchestrator` provisions
locked-down sandboxes for every learner session.

## Network policy

The Dockerfile installs an iptables script that runs at container boot:

  - ALLOW: registry.npmjs.org, pypi.org, files.pythonhosted.org,
           maven.apache.org (for Java), repo.maven.apache.org,
           dl.google.com (Android tooling deps), DNS resolvers.
  - DENY:  everything else outbound.

Compass calls go through the backend, not the sandbox, so this doesn't
break the AI pair. Test runs and `npm install` / `pip install` keep
working because the registries are whitelisted.

## Build + push

You need the e2b CLI installed locally (`npm install -g @e2b/cli`) and
e2b authenticated (`e2b auth login` — uses your account that owns
E2B_API_KEY).

  cd infra/e2b-templates/python-locked
  e2b template build --name scaleup-python-locked

  cd ../node-locked
  e2b template build --name scaleup-node-locked

  cd ../java-locked
  e2b template build --name scaleup-java-locked

The build command prints the template ID. Set:

  E2B_TEMPLATE_PYTHON=<id>
  E2B_TEMPLATE_NODE=<id>
  E2B_TEMPLATE_JAVA=<id>

on the backend (Vercel/EC2 secrets manager/whatever you use) and restart
the workers. `sandboxOrchestrator.e2bAdapter` automatically picks these
up via `TEMPLATE_BY_LANG`.

## Verifying the lockdown

After building, you can verify with:

  e2b sandbox start --template scaleup-node-locked
  # in the sandbox shell:
  curl -m 5 https://registry.npmjs.org    # → 200 expected
  curl -m 5 https://example.com           # → connection refused expected

## Why iptables and not a sidecar proxy

A sidecar adds a process to every sandbox and turns "allow npm" into
"trust the proxy doesn't have a bug." iptables is exactly the layer of
the network stack we want, and the rules are 20 lines you can audit at
a glance.
