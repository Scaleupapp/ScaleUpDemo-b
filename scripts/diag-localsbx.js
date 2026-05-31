'use strict';
// TEMP diagnostic — can the server-side localSandbox actually run npm tests?
require('dotenv').config();
const sandbox = require('../src/coding/services/sandbox/localSandbox');

(async () => {
  console.log('===== LOCALSANDBOX DIAG =====');
  const env = await sandbox.runInTempDir({
    files: [],
    command: 'echo "PATH=$PATH"; which node || echo "no node"; which npm || echo "no npm"; node --version 2>&1; npm --version 2>&1',
    timeout_ms: 30000,
  });
  console.log('[env] exit=', env.exit_code, 'timed_out=', env.timed_out);
  console.log('[env] stdout:', (env.stdout || '').slice(0, 600));
  console.log('[env] stderr:', (env.stderr || '').slice(0, 400));

  const files = [{
    path: 'package.json',
    content: JSON.stringify({ name: 't', version: '0.0.0', private: true, scripts: { test: 'node -e "process.exit(0)"' }, dependencies: { 'lodash': '^4.17.21' } }),
  }];
  const r = await sandbox.runInTempDir({
    files,
    command: 'npm install --silent --no-audit --no-fund && npm test --silent',
    timeout_ms: 120000,
  });
  console.log('[npm] exit=', r.exit_code, 'timed_out=', r.timed_out);
  console.log('[npm] stdout:', (r.stdout || '').slice(0, 800));
  console.log('[npm] stderr:', (r.stderr || '').slice(0, 800));
  console.log('===== END =====');
  process.exit(0);
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
