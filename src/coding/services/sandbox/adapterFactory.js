'use strict';

/**
 * Sandbox adapter factory.
 *
 * Single seam through which the rest of the codebase asks "give me a sandbox
 * adapter." Reads `SANDBOX_PROVIDER` from env (default 'e2b').
 *
 * Swapping providers in prod = changing one env var. The actual adapter
 * implementation lives in e2bAdapter.js / daytonaAdapter.js / etc.
 */

const e2bAdapter = require('./e2bAdapter');

const PROVIDERS = {
  e2b: e2bAdapter,
  // daytona: require('./daytonaAdapter'),    // added when WS0 NO-GOes e2b
  // local:   require('./localAdapter'),       // dev-only adapter (existing localSandbox.js)
};

function getSandboxAdapter() {
  const name = (process.env.SANDBOX_PROVIDER || 'e2b').toLowerCase();
  const adapter = PROVIDERS[name];
  if (!adapter) {
    const available = Object.keys(PROVIDERS).join(', ');
    throw new Error(`Unknown SANDBOX_PROVIDER "${name}". Available: ${available}`);
  }
  return adapter;
}

module.exports = { getSandboxAdapter };
