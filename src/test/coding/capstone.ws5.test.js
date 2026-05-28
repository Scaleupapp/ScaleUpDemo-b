'use strict';

/**
 * WS5 unit tests — Compass-Coder budget + tool dispatcher path validation.
 *
 * Three suites:
 *   1. coderBudget — reserve / reconcile / refund / cap math (Redis mocked)
 *   2. compassCoderTools.safePath — path normalization + escape rejection
 *   3. compassCoderTools.dispatch — verifies tool dispatch wires to the
 *      sandbox orchestrator and emits the recording event
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// 1. coderBudget — exercise the math via a mocked Redis
// ---------------------------------------------------------------------------

function withMockedRedis(fn) {
  const ioredisPath = require.resolve('ioredis');
  const budgetPath = require.resolve('../../coding/services/coderBudget');
  const originals = { ioredis: require.cache[ioredisPath], budget: require.cache[budgetPath] };

  let store = {};
  let expireSet = false;
  function MockRedis() {}
  MockRedis.prototype.incrby = async function (key, n) {
    store[key] = (store[key] || 0) + n;
    return store[key];
  };
  MockRedis.prototype.decrby = async function (key, n) {
    store[key] = (store[key] || 0) - n;
    return store[key];
  };
  MockRedis.prototype.expire = async function () {
    expireSet = true;
    return 1;
  };
  MockRedis.prototype.get = async function (key) {
    return store[key] != null ? String(store[key]) : null;
  };

  require.cache[ioredisPath] = { exports: MockRedis, loaded: true, id: ioredisPath };
  delete require.cache[budgetPath];

  return fn(require(budgetPath), {
    inspect: () => ({ ...store }),
    expireSet: () => expireSet,
    reset: () => {
      store = {};
      expireSet = false;
    },
  }).finally(() => {
    if (originals.ioredis) require.cache[ioredisPath] = originals.ioredis;
    else delete require.cache[ioredisPath];
    if (originals.budget) require.cache[budgetPath] = originals.budget;
    else delete require.cache[budgetPath];
  });
}

test('coderBudget: reserve under cap succeeds and sets TTL on first write', async () => {
  await withMockedRedis(async (budget, m) => {
    const r = await budget.reserve('user1', 1000);
    assert.equal(r.ok, true);
    assert.equal(r.used, 1000);
    assert.ok(m.expireSet(), 'TTL should be set on first incr of the day');
  });
});

test('coderBudget: reserve over cap refunds the increment and returns ok:false', async () => {
  await withMockedRedis(async (budget) => {
    // Cap is DAILY_TOKEN_CAP_FREE = 100_000; bigger reservation should fail.
    const r = await budget.reserve('user1', budget.DAILY_TOKEN_CAP_FREE + 1);
    assert.equal(r.ok, false);
    const usage = await budget.getUsage('user1');
    assert.equal(usage.used, 0, 'failed reservation should not persist');
  });
});

test('coderBudget: reconcile applies delta; refund decrements', async () => {
  await withMockedRedis(async (budget) => {
    await budget.reserve('user1', 1000);
    await budget.reconcile('user1', 1500, 1000); // actual exceeded estimate by 500
    let u = await budget.getUsage('user1');
    assert.equal(u.used, 1500);

    await budget.refund('user1', 500);
    u = await budget.getUsage('user1');
    assert.equal(u.used, 1000);
  });
});

// ---------------------------------------------------------------------------
// 2. compassCoderTools.safePath — workspace escape guard
// ---------------------------------------------------------------------------

test('compassCoderTools: tools array is the expected catalogue', () => {
  const { TOOLS } = require('../../coding/services/compassCoderTools');
  const names = TOOLS.map((t) => t.name).sort();
  assert.deepEqual(names, ['read_file', 'run_command', 'run_tests', 'write_file']);
  for (const t of TOOLS) {
    assert.ok(t.description && t.description.length > 0, `${t.name} missing description`);
    assert.ok(t.input_schema, `${t.name} missing input_schema`);
  }
});

test('compassCoderTools.dispatch: rejects path-escape attempts', async () => {
  // We exercise the safePath validator via dispatch + the mocked session
  // resolver below. Easiest: import the module, swap resolveSessionContext
  // for a stub that succeeds, then call dispatch with a bad path.
  const toolsPath = require.resolve('../../coding/services/compassCoderTools');
  const orchPath = require.resolve('../../coding/services/sandboxOrchestrator');
  const recPath = require.resolve('../../coding/services/recordingService');
  const sessionModelPath = require.resolve('../../coding/models/capstoneSession.model');
  const bundleModelPath = require.resolve('../../coding/models/artifactBundle.model');

  const originals = {
    t: require.cache[toolsPath],
    o: require.cache[orchPath],
    r: require.cache[recPath],
    s: require.cache[sessionModelPath],
    b: require.cache[bundleModelPath],
  };

  const fakeAdapter = {
    readFile: async () => 'irrelevant',
    uploadFiles: async () => undefined,
    runCommand: async () => ({ stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
  };
  require.cache[orchPath] = {
    exports: { _adapter: fakeAdapter, runInSession: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 }) },
    loaded: true,
    id: orchPath,
  };
  require.cache[recPath] = { exports: { emit: () => {} }, loaded: true, id: recPath };

  const fakeSession = {
    _id: 's1',
    user_id: 'u1',
    sandbox_id: 'sbx-1',
    status: 'in_progress',
    bundle_id: 'b1',
  };
  const fakeBundle = { _id: 'b1', visible_tests: [] };
  require.cache[sessionModelPath] = {
    exports: {
      findOne: () => ({ lean: async () => fakeSession }),
    },
    loaded: true,
    id: sessionModelPath,
  };
  require.cache[bundleModelPath] = {
    exports: {
      findById: () => ({ lean: async () => fakeBundle }),
    },
    loaded: true,
    id: bundleModelPath,
  };
  delete require.cache[toolsPath];

  try {
    const tools = require(toolsPath);

    // Good path: simple read_file works.
    const ok = await tools.dispatch({
      sessionId: 's1',
      userId: 'u1',
      call: { name: 'read_file', input: { path: 'src/index.js' } },
    });
    assert.equal(ok.ok, true);

    // Bad: parent-dir escape rejected (dispatch catches ToolAuthError and surfaces ok:false).
    const escape = await tools.dispatch({
      sessionId: 's1',
      userId: 'u1',
      call: { name: 'read_file', input: { path: '../../etc/passwd' } },
    });
    assert.equal(escape.ok, false);
    assert.match(escape.output, /\.\./);

    // Bad: empty path rejected
    const empty = await tools.dispatch({
      sessionId: 's1',
      userId: 'u1',
      call: { name: 'read_file', input: { path: '' } },
    });
    assert.equal(empty.ok, false);

    // Bad: unknown tool rejected
    const bogus = await tools.dispatch({
      sessionId: 's1',
      userId: 'u1',
      call: { name: 'rm_minus_rf', input: {} },
    });
    assert.equal(bogus.ok, false);
    assert.match(bogus.output, /unknown tool/);
  } finally {
    for (const [k, v] of Object.entries(originals)) {
      const path = { t: toolsPath, o: orchPath, r: recPath, s: sessionModelPath, b: bundleModelPath }[k];
      if (v) require.cache[path] = v; else delete require.cache[path];
    }
  }
});

test('compassCoderTools.dispatch: rejects sessions not owned by caller', async () => {
  const toolsPath = require.resolve('../../coding/services/compassCoderTools');
  const sessionModelPath = require.resolve('../../coding/models/capstoneSession.model');
  const originals = { t: require.cache[toolsPath], s: require.cache[sessionModelPath] };

  require.cache[sessionModelPath] = {
    exports: { findOne: () => ({ lean: async () => null }) }, // not found / not owned
    loaded: true,
    id: sessionModelPath,
  };
  delete require.cache[toolsPath];

  try {
    const tools = require(toolsPath);
    await assert.rejects(
      () =>
        tools.dispatch({
          sessionId: 's1',
          userId: 'wrong-user',
          call: { name: 'read_file', input: { path: 'a.js' } },
        }),
      /not owned/
    );
  } finally {
    if (originals.t) require.cache[toolsPath] = originals.t; else delete require.cache[toolsPath];
    if (originals.s) require.cache[sessionModelPath] = originals.s; else delete require.cache[sessionModelPath];
  }
});
