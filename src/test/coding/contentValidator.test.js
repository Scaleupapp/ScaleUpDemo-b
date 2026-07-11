'use strict';

/**
 * Unit tests for src/coding/services/contentValidator.js
 *
 * - ArtifactBundle and HumanReviewQueue static methods are stubbed — no DB.
 * - sandbox.runInTempDir is replaced before the service is loaded.
 * - llmRouter.llmCall is replaced with a deterministic stub.
 */

process.env.OPENAI_API_KEY    = process.env.OPENAI_API_KEY    || 'stub';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub';

const test   = require('node:test');
const assert = require('node:assert/strict');

// ── LLM stub — patched before the service is loaded ──────────────────────────

const llmRouter = require('../../coding/services/llmRouter');

// Default stub: returns a passing semantic check. Overridden per-test.
let stubLlmResponse = {
  content: { parts: [{ text: JSON.stringify({ difficulty_matches: true, brief_unambiguous: true, notes: 'good' }) }] },
};

llmRouter.llmCall = async () => {
  if (!stubLlmResponse) throw new Error('stubLlmResponse not set');
  return stubLlmResponse;
};

// ── Sandbox stub — patched before the service is loaded ──────────────────────
// The validator runs tests in the e2b sandbox via adapterFactory. Stub the
// factory (require.cache, installed BEFORE contentValidator loads) with a fake
// adapter whose runCommand consults `sandboxMode`.

/**
 * Controls what each sandbox test run returns.
 * - 'pass'   → exit 0
 * - 'fail'   → exit 1
 * - a function → called with ({ command }) returning { exit_code, stdout, stderr, timed_out }
 */
let sandboxMode = 'pass';

const fakeAdapter = {
  provision: async () => ({ sandboxId: 'sb-test', provisionMs: 1 }),
  runCommand: async (_id, command) => {
    let r;
    if (typeof sandboxMode === 'function') r = await sandboxMode({ command });
    else if (sandboxMode === 'pass') r = { exit_code: 0, stdout: '', stderr: '', timed_out: false };
    else r = { exit_code: 1, stdout: '', stderr: 'err', timed_out: false };
    return { exitCode: r.exit_code, stdout: r.stdout || '', stderr: r.stderr || '', durationMs: 1 };
  },
  destroy: async () => {},
  isAlive: async () => true,
};

const adapterFactoryPath = require.resolve('../../coding/services/sandbox/adapterFactory');
require.cache[adapterFactoryPath] = {
  id: adapterFactoryPath,
  filename: adapterFactoryPath,
  loaded: true,
  exports: { getSandboxAdapter: () => fakeAdapter },
};

// ── Model stubs ───────────────────────────────────────────────────────────────

const { ArtifactBundle, HumanReviewQueue } = require('../../coding/models');

// Stub state — reset/overridden per-test
let stubBundle     = null;
let capturedUpdate = null;
let stubFindOne    = null;
let capturedCreate = null;

ArtifactBundle.findById = (id) => ({
  lean: () => Promise.resolve(stubBundle),
});

ArtifactBundle.findByIdAndUpdate = async (id, update) => {
  capturedUpdate = { id, update };
  return {};
};

// The validator stamps via a conditional findOneAndUpdate (draft-only guard).
ArtifactBundle.findOneAndUpdate = async (filter, update) => {
  capturedUpdate = { filter, update };
  return {};
};

ArtifactBundle.findOne = async (filter) => {
  if (stubFindOne !== undefined) return stubFindOne;
  return null;
};

HumanReviewQueue.create = async (doc) => {
  capturedCreate = doc;
  return doc;
};

// ── Module under test — loaded AFTER stubs are in place ──────────────────────

const { validate, pushToHumanReview, checkTestsDistinct, checkContentHashUnique } =
  require('../../coding/services/contentValidator');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BUNDLE_ID = '507f1f77bcf86cd799439011';

const COMPLETE_BUNDLE = {
  _id: BUNDLE_ID,
  type: 'drill',
  drill_subtype: 'verify',
  role_track: 'swe',
  language: 'python',
  difficulty: 'easy',
  time_budget_minutes: 10,
  brief: 'Write a function that reverses a string.',
  content_hash: 'abc123def456abc123def456abc123def456abc123def456abc123def456abcd',
  status: 'draft',
  reference_solution: {
    files: [{ path: 'solution.py', content: 'def reverse(s): return s[::-1]' }],
  },
  starter_repo: {
    files: [{ path: 'starter.py', content: '# TODO' }],
  },
  visible_tests: [
    { name: 'test_reverse_basic', command: 'python -m pytest test_basic.py', expected_exit_code: 0 },
  ],
  hidden_tests: [
    { name: 'test_reverse_edge', command: 'python -m pytest test_edge.py', expected_exit_code: 0 },
  ],
  seeded_mistakes: [
    { location: 'solution.py', bug_description: 'Off-by-one error' },
  ],
  generated_by: { generator_model: 'claude-opus-4-7', human_reviewed: false },
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. checkTestsDistinct — distinct names → ok
// ─────────────────────────────────────────────────────────────────────────────

test('checkTestsDistinct: distinct test names → { ok: true }', () => {
  const bundle = {
    visible_tests: [{ name: 'a' }, { name: 'b' }],
    hidden_tests:  [{ name: 'c' }, { name: 'd' }],
  };
  const result = checkTestsDistinct(bundle);
  assert.strictEqual(result.ok, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. checkTestsDistinct — overlapping name → fail with error
// ─────────────────────────────────────────────────────────────────────────────

test('checkTestsDistinct: overlapping test name → { ok: false } with overlap in error', () => {
  const bundle = {
    visible_tests: [{ name: 'test_foo' }, { name: 'test_bar' }],
    hidden_tests:  [{ name: 'test_foo' }, { name: 'test_baz' }],
  };
  const result = checkTestsDistinct(bundle);
  assert.strictEqual(result.ok, false);
  assert.ok(typeof result.error === 'string', 'error should be a string');
  assert.ok(result.error.includes('test_foo'), `error should name the overlapping test, got: ${result.error}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. validate — happy path: all checks pass
// ─────────────────────────────────────────────────────────────────────────────

test('validate: happy path — all checks pass → status updated to validated', async () => {
  stubBundle     = { ...COMPLETE_BUNDLE };
  capturedUpdate = null;
  stubFindOne    = null;
  sandboxMode    = (opts) => {
    // Reference run (first two calls for visible+hidden) → pass
    // Corrupted run (next two calls) → fail (exit 1)
    // We use a call counter to distinguish
    sandboxMode._call = (sandboxMode._call || 0) + 1;
    if (sandboxMode._call <= 2) return Promise.resolve({ exit_code: 0, stdout: '', stderr: '', timed_out: false });
    return Promise.resolve({ exit_code: 1, stdout: '', stderr: 'err', timed_out: false });
  };
  sandboxMode._call = 0;

  stubLlmResponse = {
    content: { parts: [{ text: JSON.stringify({ difficulty_matches: true, brief_unambiguous: true, notes: 'looks good' }) }] },
  };

  const result = await validate({ bundle_id: BUNDLE_ID });

  assert.strictEqual(result.ok, true, `expected ok:true, got: ${JSON.stringify(result)}`);
  assert.ok(capturedUpdate, 'findOneAndUpdate should have been called');
  const set = capturedUpdate.update.$set;
  assert.strictEqual(set.status, 'validated',
    `expected status to be updated to "validated", got: ${JSON.stringify(capturedUpdate.update)}`);
  assert.ok(set['generated_by.validated_at'] instanceof Date, 'validated_at should be a Date');
  // validator_model must come from the routing table, not a hardcoded string.
  assert.strictEqual(
    set['generated_by.validator_model'],
    llmRouter.getModelForTask('content_validator_cross').model,
    'validator_model should be sourced from llmRouter',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. validate — reference solution fails
// ─────────────────────────────────────────────────────────────────────────────

test('validate: reference solution fails tests → { ok: false }', async () => {
  stubBundle  = { ...COMPLETE_BUNDLE };
  sandboxMode = 'fail'; // all sandbox calls fail

  const result = await validate({ bundle_id: BUNDLE_ID });

  assert.strictEqual(result.ok, false, `expected ok:false, got: ${JSON.stringify(result)}`);
  assert.ok(Array.isArray(result.errors), 'errors should be an array');
  assert.ok(
    result.errors.some(e => e.includes('reference_solution')),
    `expected an error mentioning reference_solution, got: ${JSON.stringify(result.errors)}`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. validate — non-solution check fails (tests pass even when corrupted)
// ─────────────────────────────────────────────────────────────────────────────

test('validate: non-solution (corrupted code) still passes → { ok: false }', async () => {
  stubBundle  = { ...COMPLETE_BUNDLE };
  sandboxMode = 'pass'; // ALL sandbox calls pass — including corrupted run

  const result = await validate({ bundle_id: BUNDLE_ID });

  assert.strictEqual(result.ok, false, `expected ok:false, got: ${JSON.stringify(result)}`);
  assert.ok(
    result.errors.some(e => e.includes('non_solution_fails')),
    `expected error mentioning non_solution_fails, got: ${JSON.stringify(result.errors)}`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. validate — semantic check fails (difficulty mismatch from Gemini)
// ─────────────────────────────────────────────────────────────────────────────

test('validate: semantic check fails (difficulty_matches false) → { ok: false }', async () => {
  stubBundle  = { ...COMPLETE_BUNDLE };
  sandboxMode = (opts) => {
    sandboxMode._call = (sandboxMode._call || 0) + 1;
    if (sandboxMode._call <= 2) return Promise.resolve({ exit_code: 0, stdout: '', stderr: '', timed_out: false });
    return Promise.resolve({ exit_code: 1, stdout: '', stderr: 'err', timed_out: false });
  };
  sandboxMode._call = 0;

  stubFindOne = null;

  stubLlmResponse = {
    content: { parts: [{ text: JSON.stringify({ difficulty_matches: false, brief_unambiguous: true, notes: 'too hard for easy' }) }] },
  };

  const result = await validate({ bundle_id: BUNDLE_ID });

  assert.strictEqual(result.ok, false, `expected ok:false, got: ${JSON.stringify(result)}`);
  assert.ok(
    result.errors.some(e => e.includes('semantic_consistency')),
    `expected error mentioning semantic_consistency, got: ${JSON.stringify(result.errors)}`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. validate — content_hash duplicate found
// ─────────────────────────────────────────────────────────────────────────────

test('validate: duplicate content_hash → { ok: false }', async () => {
  stubBundle  = { ...COMPLETE_BUNDLE };
  sandboxMode = (opts) => {
    sandboxMode._call = (sandboxMode._call || 0) + 1;
    if (sandboxMode._call <= 2) return Promise.resolve({ exit_code: 0, stdout: '', stderr: '', timed_out: false });
    return Promise.resolve({ exit_code: 1, stdout: '', stderr: 'err', timed_out: false });
  };
  sandboxMode._call = 0;

  stubFindOne = { _id: '507f1f77bcf86cd799439022', content_hash: COMPLETE_BUNDLE.content_hash };

  stubLlmResponse = {
    content: { parts: [{ text: JSON.stringify({ difficulty_matches: true, brief_unambiguous: true, notes: 'ok' }) }] },
  };

  const result = await validate({ bundle_id: BUNDLE_ID });

  assert.strictEqual(result.ok, false, `expected ok:false, got: ${JSON.stringify(result)}`);
  assert.ok(
    result.errors.some(e => e.includes('content_hash_unique')),
    `expected error mentioning content_hash_unique, got: ${JSON.stringify(result.errors)}`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. validate — bundle not found → throws
// ─────────────────────────────────────────────────────────────────────────────

test('validate: bundle not found → throws Error', async () => {
  stubBundle = null;

  await assert.rejects(
    () => validate({ bundle_id: BUNDLE_ID }),
    (err) => {
      assert.ok(err instanceof Error, 'should throw an Error');
      assert.ok(
        err.message.includes(BUNDLE_ID),
        `error should include the bundle_id, got: ${err.message}`,
      );
      return true;
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. pushToHumanReview — creates the right doc
// ─────────────────────────────────────────────────────────────────────────────

test('pushToHumanReview: creates HumanReviewQueue doc with correct fields', async () => {
  capturedCreate = null;

  await pushToHumanReview({
    bundle_id: BUNDLE_ID,
    errors: ['reference_solution_passes: tests failed', 'semantic_consistency: difficulty mismatch'],
  });

  assert.ok(capturedCreate, 'HumanReviewQueue.create should have been called');
  assert.strictEqual(capturedCreate.bundle_id, BUNDLE_ID);
  assert.strictEqual(capturedCreate.reason, 'validator_failed');
  assert.deepStrictEqual(
    capturedCreate.validator_errors,
    ['reference_solution_passes: tests failed', 'semantic_consistency: difficulty mismatch'],
  );
  assert.strictEqual(capturedCreate.status, 'pending');
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. checkSeededMistakesFail — real mechanical checks (Wave 2 block 5)
// ─────────────────────────────────────────────────────────────────────────────

test('validate: seeded_mistake location referencing a non-existent file → { ok: false }', async () => {
  stubBundle = {
    ...COMPLETE_BUNDLE,
    seeded_mistakes: [{ location: 'ghost.py:3', bug_description: 'Imaginary bug' }],
  };
  stubFindOne = null;
  // Reference passes (calls 1-2), corrupted fails (3-4). Seeded check rejects
  // on the referential check BEFORE any sandbox run.
  sandboxMode = (opts) => {
    sandboxMode._call = (sandboxMode._call || 0) + 1;
    if (sandboxMode._call <= 2) return Promise.resolve({ exit_code: 0, stdout: '', stderr: '', timed_out: false });
    return Promise.resolve({ exit_code: 1, stdout: '', stderr: 'err', timed_out: false });
  };
  sandboxMode._call = 0;
  stubLlmResponse = {
    content: { parts: [{ text: JSON.stringify({ difficulty_matches: true, brief_unambiguous: true, notes: 'ok' }) }] },
  };

  const result = await validate({ bundle_id: BUNDLE_ID });
  assert.strictEqual(result.ok, false, `expected ok:false, got: ${JSON.stringify(result)}`);
  assert.ok(
    result.errors.some(e => e.includes('seeded_mistakes_fail') && e.includes('ghost.py:3')),
    `expected seeded location error, got: ${JSON.stringify(result.errors)}`,
  );
});

test('validate: seeded_mistake line out of range → { ok: false }', async () => {
  stubBundle = {
    ...COMPLETE_BUNDLE,
    seeded_mistakes: [{ location: 'starter.py:99', bug_description: 'Bug on a line that does not exist' }],
  };
  stubFindOne = null;
  sandboxMode = (opts) => {
    sandboxMode._call = (sandboxMode._call || 0) + 1;
    if (sandboxMode._call <= 2) return Promise.resolve({ exit_code: 0, stdout: '', stderr: '', timed_out: false });
    return Promise.resolve({ exit_code: 1, stdout: '', stderr: 'err', timed_out: false });
  };
  sandboxMode._call = 0;

  const result = await validate({ bundle_id: BUNDLE_ID });
  assert.strictEqual(result.ok, false);
  assert.ok(
    result.errors.some(e => e.includes('out of range')),
    `expected out-of-range error, got: ${JSON.stringify(result.errors)}`,
  );
});

test('validate: starter passes ALL tests despite seeded_mistakes → { ok: false }', async () => {
  stubBundle = { ...COMPLETE_BUNDLE };
  stubFindOne = null;
  // Reference passes (1-2), corrupted fails (3-4), seeded/starter run PASSES
  // (5-6) → the "buggy" starter is not detectably buggy → reject.
  sandboxMode = (opts) => {
    sandboxMode._call = (sandboxMode._call || 0) + 1;
    if (sandboxMode._call <= 2) return Promise.resolve({ exit_code: 0, stdout: '', stderr: '', timed_out: false });
    if (sandboxMode._call <= 4) return Promise.resolve({ exit_code: 1, stdout: '', stderr: 'err', timed_out: false });
    return Promise.resolve({ exit_code: 0, stdout: '', stderr: '', timed_out: false });
  };
  sandboxMode._call = 0;
  stubLlmResponse = {
    content: { parts: [{ text: JSON.stringify({ difficulty_matches: true, brief_unambiguous: true, notes: 'ok' }) }] },
  };

  const result = await validate({ bundle_id: BUNDLE_ID });
  assert.strictEqual(result.ok, false, `expected ok:false, got: ${JSON.stringify(result)}`);
  assert.ok(
    result.errors.some(e => e.includes('seeded_mistakes')),
    `expected seeded_mistakes error, got: ${JSON.stringify(result.errors)}`,
  );
});

test('validate: no seeded_mistakes → seeded check skipped, bundle validates', async () => {
  stubBundle = { ...COMPLETE_BUNDLE, seeded_mistakes: [] };
  stubFindOne = null;
  capturedUpdate = null;
  sandboxMode = (opts) => {
    sandboxMode._call = (sandboxMode._call || 0) + 1;
    if (sandboxMode._call <= 2) return Promise.resolve({ exit_code: 0, stdout: '', stderr: '', timed_out: false });
    return Promise.resolve({ exit_code: 1, stdout: '', stderr: 'err', timed_out: false });
  };
  sandboxMode._call = 0;
  stubLlmResponse = {
    content: { parts: [{ text: JSON.stringify({ difficulty_matches: true, brief_unambiguous: true, notes: 'ok' }) }] },
  };

  const result = await validate({ bundle_id: BUNDLE_ID });
  assert.strictEqual(result.ok, true, `expected ok:true, got: ${JSON.stringify(result)}`);
  const seeded = result.results.find(r => r.name === 'seeded_mistakes_fail');
  assert.strictEqual(seeded.skipped, true, 'seeded check should be skipped with no mistakes');
});
