'use strict';

/**
 * Unit tests for src/coding/services/generationPipeline.js
 *
 * All dependencies (contentGenerator, contentValidator) are stubbed — no DB
 * connection or LLM calls required.
 *
 * Tests:
 *  1. Happy path — first attempt validates
 *  2. Second attempt validates (retry with critique)
 *  3. All retries exhausted → human review queue
 *  4. Critique is passed on retry call to generate
 *  5. getMetrics returns expected shape across multiple runs
 *  6. resetMetrics clears all state
 */

process.env.OPENAI_API_KEY    = process.env.OPENAI_API_KEY    || 'stub';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub';

const test   = require('node:test');
const assert = require('node:assert/strict');

// ── Stub contentGenerator ─────────────────────────────────────────────────────

const contentGenerator = require('../../coding/services/contentGenerator');

// We'll override `generate` per-test
const originalGenerate = contentGenerator.generate;

// ── Stub contentValidator ─────────────────────────────────────────────────────

const contentValidator = require('../../coding/services/contentValidator');

const originalValidate         = contentValidator.validate;
const originalPushToHumanReview = contentValidator.pushToHumanReview;

// ── Module under test — loaded AFTER stubs are in place ──────────────────────

const { runPipeline, getMetrics, resetMetrics } =
  require('../../coding/services/generationPipeline');

// ── Helper: reset stubs + metrics before each group ──────────────────────────

function cleanup() {
  contentGenerator.generate       = originalGenerate;
  contentValidator.validate        = originalValidate;
  contentValidator.pushToHumanReview = originalPushToHumanReview;
  resetMetrics();
}

// ── Test 1: Happy path — first attempt validates ──────────────────────────────

test('runPipeline: happy path — first attempt validates', async () => {
  cleanup();

  contentGenerator.generate = async () => ({ _id: 'draft1' });
  contentValidator.validate = async ({ bundle_id }) => {
    assert.strictEqual(bundle_id, 'draft1');
    return { ok: true };
  };

  const result = await runPipeline({
    role_track:    'swe',
    drill_subtype: 'prompt',
    difficulty:    'easy',
    language:      'python',
  });

  assert.strictEqual(result.ok, true,          'result.ok should be true');
  assert.strictEqual(result.bundle_id, 'draft1', 'bundle_id should be "draft1"');
  assert.strictEqual(result.attempts, 1,        'attempts should be 1');
  assert.ok(typeof result.duration_ms === 'number', 'duration_ms should be a number');

  const m = getMetrics();
  assert.strictEqual(m.totalRuns,      1, 'totalRuns should be 1');
  assert.strictEqual(m.passOnFirstTry, 1, 'passOnFirstTry should be 1');
  assert.strictEqual(m.totalAttempts,  1, 'totalAttempts should be 1');
  assert.strictEqual(m.humanReviewCount, 0, 'humanReviewCount should be 0');
});

// ── Test 2: Second attempt validates ─────────────────────────────────────────

test('runPipeline: second attempt validates — retry with critique', async () => {
  cleanup();

  let generateCallCount = 0;
  contentGenerator.generate = async () => {
    generateCallCount += 1;
    return { _id: `draft${generateCallCount}` };
  };

  let validateCallCount = 0;
  contentValidator.validate = async () => {
    validateCallCount += 1;
    if (validateCallCount === 1) return { ok: false, errors: ['error1'] };
    return { ok: true };
  };

  const result = await runPipeline({
    role_track:    'swe',
    drill_subtype: 'prompt',
    difficulty:    'easy',
    language:      'python',
  });

  assert.strictEqual(result.ok, true,          'result.ok should be true');
  assert.strictEqual(result.bundle_id, 'draft2', 'bundle_id should be the second draft');
  assert.strictEqual(result.attempts, 2,         'attempts should be 2');

  const m = getMetrics();
  assert.strictEqual(m.passOnFirstTry,  0, 'passOnFirstTry should be 0 (first attempt failed)');
  assert.strictEqual(m.totalAttempts,   2, 'totalAttempts should be 2');
  assert.strictEqual(m.humanReviewCount, 0, 'humanReviewCount should be 0');
});

// ── Test 3: All retries exhausted → human review queue ───────────────────────

test('runPipeline: all retries exhausted — pushes to human review queue', async () => {
  cleanup();

  let generateCallCount = 0;
  contentGenerator.generate = async () => {
    generateCallCount += 1;
    return { _id: `draft${generateCallCount}` };
  };

  contentValidator.validate = async () => ({
    ok: false,
    errors: ['test_failed', 'duplicate_hash'],
  });

  let humanReviewArgs = null;
  contentValidator.pushToHumanReview = async (args) => {
    humanReviewArgs = args;
  };

  const result = await runPipeline(
    { role_track: 'swe', drill_subtype: 'prompt', difficulty: 'easy', language: 'python' },
    { maxRetries: 3 },
  );

  // maxRetries=3 means 4 total attempts (1 initial + 3 retries)
  assert.strictEqual(result.ok, false,  'result.ok should be false');
  assert.strictEqual(result.attempts, 4, 'attempts should be 4 (maxRetries=3 → 4 total)');
  assert.ok(Array.isArray(result.errors), 'result.errors should be an array');

  assert.ok(humanReviewArgs !== null,            'pushToHumanReview should have been called');
  assert.strictEqual(humanReviewArgs.bundle_id, 'draft4', 'should push the last draft id');
  assert.deepStrictEqual(
    humanReviewArgs.errors, ['test_failed', 'duplicate_hash'],
    'should pass the last validation errors',
  );

  const m = getMetrics();
  assert.strictEqual(m.humanReviewCount, 1, 'humanReviewCount should be 1');
  assert.strictEqual(m.totalAttempts,    4, 'totalAttempts should be 4');
});

// ── Test 4: Critique is passed on retry ──────────────────────────────────────

test('runPipeline: critique field is passed to generate on retry', async () => {
  cleanup();

  const capturedArgs = [];
  let callCount = 0;

  contentGenerator.generate = async (args) => {
    capturedArgs.push({ ...args });
    callCount += 1;
    return { _id: `draft${callCount}` };
  };

  contentValidator.validate = async () => {
    if (capturedArgs.length === 1) {
      return { ok: false, errors: ['missing test coverage', 'ambiguous brief'] };
    }
    return { ok: true };
  };

  await runPipeline({
    role_track:    'swe',
    drill_subtype: 'prompt',
    difficulty:    'easy',
    language:      'python',
    topic_hint:    'sorting',
  });

  assert.strictEqual(capturedArgs.length, 2, 'generate should be called twice');

  // First call — no critique
  assert.ok(!capturedArgs[0].critique, 'first call should not have critique field');

  // Second call — critique containing the error messages
  assert.ok(typeof capturedArgs[1].critique === 'string', 'second call should have critique string');
  assert.ok(
    capturedArgs[1].critique.includes('missing test coverage'),
    `critique should include first error, got: ${capturedArgs[1].critique}`,
  );
  assert.ok(
    capturedArgs[1].critique.includes('ambiguous brief'),
    `critique should include second error, got: ${capturedArgs[1].critique}`,
  );
});

// ── Test 5: getMetrics returns expected shape across multiple runs ─────────────

test('getMetrics: aggregates stats correctly across multiple runs', async () => {
  cleanup();

  // Run 1: passes on first try
  contentGenerator.generate = async () => ({ _id: 'x1' });
  contentValidator.validate  = async () => ({ ok: true });
  await runPipeline({ role_track: 'swe', drill_subtype: 'prompt', difficulty: 'easy', language: 'python' });

  // Run 2: fails → human review (maxRetries=1 → 2 total attempts)
  let gc2 = 0;
  contentGenerator.generate = async () => { gc2++; return { _id: `y${gc2}` }; };
  contentValidator.validate  = async () => ({ ok: false, errors: ['e'] });
  contentValidator.pushToHumanReview = async () => {};
  await runPipeline(
    { role_track: 'swe', drill_subtype: 'prompt', difficulty: 'easy', language: 'python' },
    { maxRetries: 1 },
  );

  const m = getMetrics();
  assert.strictEqual(m.totalRuns,        2, 'totalRuns should be 2');
  assert.strictEqual(m.passOnFirstTry,   1, 'passOnFirstTry should be 1');
  assert.strictEqual(m.totalAttempts,    3, 'totalAttempts: 1 (run1) + 2 (run2) = 3');
  assert.strictEqual(m.humanReviewCount, 1, 'humanReviewCount should be 1');
  assert.ok(typeof m.pass_on_first_try_rate === 'number', 'pass_on_first_try_rate should be a number');
  assert.ok(
    Math.abs(m.pass_on_first_try_rate - 0.5) < 0.001,
    `pass_on_first_try_rate should be 0.5, got ${m.pass_on_first_try_rate}`,
  );
});

// ── Test 6: resetMetrics clears all state ─────────────────────────────────────

test('resetMetrics: clears all aggregate state', async () => {
  cleanup();

  // Inflate metrics
  contentGenerator.generate = async () => ({ _id: 'z1' });
  contentValidator.validate  = async () => ({ ok: true });
  await runPipeline({ role_track: 'swe', drill_subtype: 'prompt', difficulty: 'easy', language: 'python' });

  let before = getMetrics();
  assert.strictEqual(before.totalRuns, 1, 'sanity: totalRuns should be 1 before reset');

  resetMetrics();

  const after = getMetrics();
  assert.strictEqual(after.totalRuns,        0,   'totalRuns should be 0 after reset');
  assert.strictEqual(after.passOnFirstTry,   0,   'passOnFirstTry should be 0 after reset');
  assert.strictEqual(after.totalAttempts,    0,   'totalAttempts should be 0 after reset');
  assert.strictEqual(after.humanReviewCount, 0,   'humanReviewCount should be 0 after reset');
  assert.strictEqual(after.pass_on_first_try_rate, 0, 'pass_on_first_try_rate should be 0 after reset');
});
