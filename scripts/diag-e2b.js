'use strict';

/**
 * TEMPORARY diagnostic — why does capstone sandbox provisioning fail in prod?
 * Read-only: prints relevant env state, then attempts ONE provision and
 * destroys it. Safe to run on prod. Remove after diagnosis.
 *
 * Run: node scripts/diag-e2b.js
 */

require('dotenv').config();

function present(v) {
  if (v === undefined || v === null || v === '') return 'UNSET';
  return `SET(len=${String(v).length})`;
}

(async () => {
  console.log('===== E2B DIAG =====');
  console.log('SANDBOX_PROVIDER          =', process.env.SANDBOX_PROVIDER || 'UNSET');
  console.log('E2B_API_KEY               =', present(process.env.E2B_API_KEY));
  console.log('E2B_REQUIRE_EGRESS_LOCKDOWN=', JSON.stringify(process.env.E2B_REQUIRE_EGRESS_LOCKDOWN));
  for (const k of ['E2B_TEMPLATE_PYTHON', 'E2B_TEMPLATE_JAVASCRIPT', 'E2B_TEMPLATE_NODE', 'E2B_TEMPLATE_JAVA']) {
    console.log(`${k.padEnd(26)}=`, process.env[k] || 'UNSET');
  }

  let adapter;
  try {
    adapter = require('../src/coding/services/sandbox/adapterFactory').getSandboxAdapter();
    console.log('adapter loaded:', adapter && adapter.constructor ? 'ok' : 'ok');
    console.log('has verifyEgressLockdown:', typeof adapter.verifyEgressLockdown === 'function');
  } catch (e) {
    console.log('ADAPTER LOAD FAILED:', e.message);
    process.exit(0);
  }

  console.log('\n--- attempting adapter.provision({image:"javascript"}) ---');
  const t0 = Date.now();
  let sandboxId = null;
  try {
    const r = await adapter.provision({ image: 'javascript', files: [], env: {}, limits: {} });
    sandboxId = r && (r.sandboxId || r.sandbox_id);
    console.log('PROVISION OK in', Date.now() - t0, 'ms — sandboxId=', sandboxId, 'hostUrl=', r && r.hostUrl);

    if (process.env.E2B_REQUIRE_EGRESS_LOCKDOWN === 'true' && typeof adapter.verifyEgressLockdown === 'function') {
      console.log('--- running verifyEgressLockdown (REQUIRE_EGRESS_LOCKDOWN=true) ---');
      try {
        const verdict = await adapter.verifyEgressLockdown(sandboxId);
        console.log('egress verdict:', JSON.stringify(verdict));
      } catch (e) {
        console.log('egress verify THREW:', e.message);
      }
    }
  } catch (e) {
    console.log('PROVISION FAILED after', Date.now() - t0, 'ms');
    console.log('error.message =', e && e.message);
    console.log('error.name    =', e && e.name);
    if (e && e.response) {
      try { console.log('error.response=', JSON.stringify(e.response).slice(0, 500)); } catch (_) {}
    }
    console.log('stack:', e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : 'n/a');
  } finally {
    if (sandboxId && typeof adapter.destroy === 'function') {
      try { await adapter.destroy(sandboxId); console.log('cleaned up sandbox', sandboxId); } catch (_) {}
    }
  }
  console.log('===== END DIAG =====');
  process.exit(0);
})();
