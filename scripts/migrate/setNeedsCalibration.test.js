const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const SCRIPT_PATH = path.resolve(__dirname, './setNeedsCalibration.js');

function load() {
  delete require.cache[SCRIPT_PATH];
  return require(SCRIPT_PATH);
}

test('migrate: targets only objectives missing topicSelfRatings', async () => {
  const calls = [];
  const FakeModel = {
    countDocuments: async (filter) => { calls.push({ op: 'count', filter }); return 42; },
    updateMany: async (filter, update) => { calls.push({ op: 'update', filter, update }); return { matchedCount: 42, modifiedCount: 42 }; },
  };
  const { runMigration } = load();
  const result = await runMigration({ Model: FakeModel, dryRun: false });
  assert.strictEqual(result.matched, 42);
  assert.strictEqual(result.modified, 42);
  // Filter must capture both "no field" and "empty map" cases.
  const updateCall = calls.find((c) => c.op === 'update');
  assert.ok(updateCall, 'updateMany should be called');
  assert.strictEqual(updateCall.update.$set.needsCalibration, true);
  // Filter shape: $or covering missing or empty
  assert.ok(Array.isArray(updateCall.filter.$or));
});

test('migrate: dry-run only counts, does not write', async () => {
  let updateCalled = false;
  const FakeModel = {
    countDocuments: async () => 7,
    updateMany: async () => { updateCalled = true; return { modifiedCount: 7 }; },
  };
  const { runMigration } = load();
  const result = await runMigration({ Model: FakeModel, dryRun: true });
  assert.strictEqual(result.matched, 7);
  assert.strictEqual(result.modified, 0);
  assert.strictEqual(updateCalled, false);
});

test('migrate: returns zero when nothing to migrate', async () => {
  const FakeModel = {
    countDocuments: async () => 0,
    updateMany: async () => { throw new Error('should not be called'); },
  };
  const { runMigration } = load();
  const result = await runMigration({ Model: FakeModel, dryRun: false });
  assert.strictEqual(result.matched, 0);
  assert.strictEqual(result.modified, 0);
});
