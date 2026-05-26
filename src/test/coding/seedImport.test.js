'use strict';

/**
 * Unit tests for the seed-coding-library import script.
 * Tests run without a real MongoDB connection — the ArtifactBundle model is
 * stubbed in-process.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkTempSeedDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scaleup-seedtest-'));
}

function writeSeed(dir, relPath, obj) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, JSON.stringify(obj));
}

function writeRaw(dir, relPath, str) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, str);
}

function validDrillBundle(overrides = {}) {
  return {
    type: 'drill',
    drill_subtype: 'prompt',
    role_track: 'swe',
    language: 'python',
    difficulty: 'easy',
    time_budget_minutes: 10,
    brief: 'Write a prompt that gets an LLM to sum two numbers correctly',
    acceptance_criteria: ['Output is a single integer'],
    reference_solution: { files: [] },
    visible_tests: [],
    hidden_tests: [],
    seeded_mistakes: [],
    rubric_anchors: [],
    expected_meta_skill_signals: {
      good_prompts_look_like: ['declares input/output types'],
      common_verification_traps: ['ambiguous output format'],
      decomposition_reference: [],
    },
    difficulty_signals: {
      token_count: 50,
      branching_complexity: 1,
      edge_cases: 2,
      known_hard_patterns: [],
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Model stub factory
// Allows per-test customisation of findOne behaviour.
// ---------------------------------------------------------------------------

function makeModelStub(options = {}) {
  // options.findOneReturn: value returned by findOne (null = not found)
  const { findOneReturn = null } = options;
  const writes = { findOne: [], create: [], updateOne: [] };

  const stub = {
    findOne: async (q) => { writes.findOne.push(q); return findOneReturn; },
    create: async (doc) => { writes.create.push(doc); return { _id: 'fake-id', ...doc }; },
    updateOne: async (q, u) => { writes.updateOne.push({ q, u }); return { acknowledged: true }; },
    _writes: writes,
  };
  return stub;
}

// ---------------------------------------------------------------------------
// Load the module under test; patch coding/models before require so that
// every test gets a fresh stub via the override mechanism below.
// ---------------------------------------------------------------------------

// We load importSeeds / findSeedFiles directly and pass modelStub via the
// exported API — but the script couples to require('../../coding/models').
// Strategy: require the script once, then in each test we monkey-patch the
// module's exports.ArtifactBundle before calling importSeeds.

const { importSeeds, findSeedFiles } =
  require('../../../scripts/seed-coding-library');

// Reference to the real models module so we can swap ArtifactBundle per test.
const modelsModule = require('../../coding/models');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('findSeedFiles: returns empty array when directory does not exist', () => {
  const result = findSeedFiles('/definitely/does/not/exist/12345');
  assert.deepStrictEqual(result, []);
});

test('findSeedFiles: finds nested JSON files', () => {
  const dir = mkTempSeedDir();
  writeSeed(dir, 'a.json', {});
  writeSeed(dir, 'sub/b.json', {});
  writeRaw(dir, 'skip.txt', 'text');
  const files = findSeedFiles(dir);
  assert.strictEqual(files.length, 2);
  assert.ok(files.every(f => f.endsWith('.json')));
});

// --- Case 1: Empty dir ---

test('importSeeds: empty seed dir → all counts zero', async () => {
  const dir = mkTempSeedDir();
  const stub = makeModelStub();
  modelsModule.ArtifactBundle = stub;

  const summary = await importSeeds({ dryRun: true, root: dir });

  assert.strictEqual(summary.found, 0);
  assert.strictEqual(summary.validated, 0);
  assert.strictEqual(summary.imported, 0);
  assert.strictEqual(summary.updated, 0);
  assert.strictEqual(summary.skipped, 0);
  assert.strictEqual(summary.failed, 0);
  assert.deepStrictEqual(summary.errors, []);
});

// --- Case 2: Valid bundle → imports successfully ---

test('importSeeds: valid bundle JSON → imported=1 (no dry-run)', async () => {
  const dir = mkTempSeedDir();
  writeSeed(dir, 'swe/easy-prompt.json', validDrillBundle());

  const stub = makeModelStub({ findOneReturn: null });
  modelsModule.ArtifactBundle = stub;

  const logs = [];
  const summary = await importSeeds({
    dryRun: false,
    root: dir,
    logger: { log: (m) => logs.push(m) },
  });

  assert.strictEqual(summary.found, 1);
  assert.strictEqual(summary.validated, 1);
  assert.strictEqual(summary.imported, 1);
  assert.strictEqual(summary.updated, 0);
  assert.strictEqual(summary.failed, 0);
  assert.strictEqual(stub._writes.create.length, 1);
  // created doc must have status: 'active' and human_reviewed: true
  const created = stub._writes.create[0];
  assert.strictEqual(created.status, 'active');
  assert.strictEqual(created.generated_by.human_reviewed, true);
});

// --- Case 3: Invalid bundle (missing required field) → failed=1 ---

test('importSeeds: bundle missing required field → failed=1, error logged', async () => {
  const dir = mkTempSeedDir();
  // Missing 'type' field — will fail Joi validation
  const bad = validDrillBundle();
  delete bad.type;
  writeSeed(dir, 'bad-bundle.json', bad);

  const stub = makeModelStub();
  modelsModule.ArtifactBundle = stub;

  const summary = await importSeeds({ dryRun: false, root: dir });

  assert.strictEqual(summary.failed, 1);
  assert.strictEqual(summary.validated, 0);
  assert.strictEqual(summary.imported, 0);
  assert.strictEqual(summary.errors.length, 1);
  assert.ok(summary.errors[0].error.startsWith('validate:'));
});

// --- Case 4: Re-import same bundle → updated=1, imported=0 ---

test('importSeeds: re-import same bundle → updated=1, imported=0', async () => {
  const dir = mkTempSeedDir();
  writeSeed(dir, 'existing.json', validDrillBundle());

  // findOne returns an existing document (simulates already-in-DB)
  const fakeExisting = { _id: 'existing-mongo-id', status: 'active' };
  const stub = makeModelStub({ findOneReturn: fakeExisting });
  modelsModule.ArtifactBundle = stub;

  const summary = await importSeeds({ dryRun: false, root: dir });

  assert.strictEqual(summary.updated, 1);
  assert.strictEqual(summary.imported, 0);
  assert.strictEqual(stub._writes.updateOne.length, 1);
  assert.strictEqual(stub._writes.create.length, 0);
});

// --- Case 5: dry-run → skipped=count, no DB writes ---

test('importSeeds: dry-run skips all DB writes', async () => {
  const dir = mkTempSeedDir();
  writeSeed(dir, 'a.json', validDrillBundle({ brief: 'Write a prompt to add two numbers' }));
  writeSeed(dir, 'b.json', validDrillBundle({ brief: 'Write a prompt to reverse a string' }));

  const stub = makeModelStub();
  modelsModule.ArtifactBundle = stub;

  const logs = [];
  const summary = await importSeeds({
    dryRun: true,
    root: dir,
    logger: { log: (m) => logs.push(m) },
  });

  assert.strictEqual(summary.found, 2);
  assert.strictEqual(summary.skipped, 2);
  assert.strictEqual(summary.imported, 0);
  assert.strictEqual(summary.updated, 0);
  assert.strictEqual(stub._writes.create.length, 0);
  assert.strictEqual(stub._writes.findOne.length, 0);
  // dry-run log lines should mention the hash
  assert.ok(logs.some(l => l.includes('[dry-run]')));
});

// --- Case 6: Multi-file: 2 valid + 1 broken ---

test('importSeeds: 3 files (2 valid, 1 invalid) → validated=2, failed=1', async () => {
  const dir = mkTempSeedDir();
  writeSeed(dir, 'a.json', validDrillBundle({ brief: 'Write a prompt to add two numbers' }));
  writeSeed(dir, 'b.json', validDrillBundle({ brief: 'Write a prompt to reverse a string' }));

  const badBundle = validDrillBundle();
  delete badBundle.language; // required field
  writeSeed(dir, 'c.json', badBundle);

  const stub = makeModelStub({ findOneReturn: null });
  modelsModule.ArtifactBundle = stub;

  const summary = await importSeeds({ dryRun: false, root: dir });

  assert.strictEqual(summary.validated, 2);
  assert.strictEqual(summary.failed, 1);
  assert.strictEqual(summary.imported, 2);
  assert.strictEqual(summary.errors.length, 1);
});

// --- Case 7: Malformed JSON → parse error ---

test('importSeeds: malformed JSON file → failed=1 with parse error', async () => {
  const dir = mkTempSeedDir();
  writeRaw(dir, 'corrupt.json', '{ this is not valid json !!');

  const stub = makeModelStub();
  modelsModule.ArtifactBundle = stub;

  const summary = await importSeeds({ dryRun: false, root: dir });

  assert.strictEqual(summary.failed, 1);
  assert.strictEqual(summary.validated, 0);
  assert.strictEqual(summary.errors.length, 1);
  assert.ok(summary.errors[0].error.startsWith('parse:'));
});

// --- Extra: seed file with pre-existing status/generated_by/content_hash stripped ---

test('importSeeds: strips status/generated_by/content_hash from seed file before hashing', async () => {
  const dir = mkTempSeedDir();
  // Seed file has stale metadata — the script must ignore them
  const bundle = validDrillBundle({
    status: 'retired',
    generated_by: { generator_model: 'old-model', human_reviewed: false },
    content_hash: 'stale-hash-that-should-be-replaced',
  });
  writeSeed(dir, 'with-meta.json', bundle);

  const stub = makeModelStub({ findOneReturn: null });
  modelsModule.ArtifactBundle = stub;

  const summary = await importSeeds({ dryRun: false, root: dir });

  assert.strictEqual(summary.imported, 1);
  assert.strictEqual(summary.failed, 0);
  const created = stub._writes.create[0];
  // Must be overridden regardless of what was in the file
  assert.strictEqual(created.status, 'active');
  assert.strictEqual(created.generated_by.human_reviewed, true);
  // content_hash must be the computed one (64-char hex), not the stale value
  assert.match(created.content_hash, /^[0-9a-f]{64}$/);
});
