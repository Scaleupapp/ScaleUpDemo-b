'use strict';
// TEMP — what DS/ML libraries are preinstalled in the e2b sandbox we validate in?
require('dotenv').config();
(async () => {
  const { getSandboxAdapter } = require('../src/coding/services/sandbox/adapterFactory');
  const adapter = getSandboxAdapter();
  let id = null;
  try {
    const p = await adapter.provision({ image: 'python', files: [], env: {}, limits: { wallClockMs: 5 * 60 * 1000 } });
    id = p.sandboxId;
    const cmd = [
      'python3 --version 2>&1; pip3 --version 2>&1 | head -1; node --version 2>&1; echo "---";',
      'python3 -c "import importlib.util as u; mods=[\'pandas\',\'numpy\',\'scipy\',\'sklearn\',\'matplotlib\',\'seaborn\',\'duckdb\',\'sqlalchemy\',\'statsmodels\',\'torch\',\'tensorflow\',\'transformers\',\'xgboost\',\'sqlite3\']; print(chr(10).join(m+\': \'+(\'yes\' if u.find_spec(m) else \'NO\') for m in mods))"',
    ].join(' ');
    const r = await adapter.runCommand(id, cmd, { timeoutMs: 60000 });
    console.log('exit', r.exitCode);
    console.log(r.stdout || '');
    console.log('ERR', (r.stderr || '').slice(0, 300));
  } catch (e) {
    console.log('ERR', e.message);
  } finally {
    if (id) await adapter.destroy(id).catch(() => {});
  }
  process.exit(0);
})();
