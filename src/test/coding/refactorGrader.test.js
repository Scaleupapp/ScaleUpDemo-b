'use strict';

/**
 * Unit tests for src/coding/services/drillGrader/refactorGrader.js
 *
 * Mongoose model methods are manually stubbed — no DB connection required.
 * llmRouter.llmCall is replaced with a deterministic stub.
 * runInTempDir (sandbox) is replaced on the module to avoid real shell exec.
 *
 * Score blend:
 *   overall_score = round((correctness * 0.5 + readability_gain * 0.25 + ai_usage_judgment * 0.25) * 10)
 * All dimensions are 0-10; overall_score is 0-100.
 */

process.env.OPENAI_API_KEY    = process.env.OPENAI_API_KEY    || 'stub';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub';

const test     = require('node:test');
const assert   = require('node:assert/strict');
const mongoose = require('mongoose');

// ── LLM stub — patched before anything requires llmRouter ────────────────────

// Default: high rubric scores. Overridden per-test.
let STUB_LLM_RESPONSE = {
  content: [{
    text: JSON.stringify({
      rubric: { readability_gain: 9, ai_usage_judgment: 8 },
      what_to_try_next: 'Consider extracting helper.',
    }),
  }],
  _meta: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
};

const llmRouter = require('../../coding/services/llmRouter');
llmRouter.llmCall = async () => STUB_LLM_RESPONSE;

// ── Sandbox stub — default returns passing result ─────────────────────────────
// We require the sandbox module first so that when refactorGrader requires it
// it gets the same cached module instance. We then replace runInTempDir.

const sbx = require('../../coding/services/sandbox/localSandbox');
sbx.runInTempDir = async () => ({ exit_code: 0, stdout: 'ok', stderr: '', timed_out: false });

// ── Model stubs ───────────────────────────────────────────────────────────────

const { ArtifactBundle, DrillAttempt } = require('../../coding/models');

const bundleId  = new mongoose.Types.ObjectId();
const attemptId = new mongoose.Types.ObjectId();
const userId    = new mongoose.Types.ObjectId();

// Bundle with two visible tests (both expect exit_code 0)
const fakeBundle = new ArtifactBundle({
  _id:                 bundleId,
  type:                'drill',
  drill_subtype:       'refactor',
  role_track:          'swe',
  language:            'python',
  difficulty:          'medium',
  time_budget_minutes: 30,
  brief:               'Refactor the provided function using Compass.',
  acceptance_criteria: ['Code is cleaner', 'Tests pass'],
  content_hash:        'testhash-refactor-001',
  status:              'active',
  starter_repo: { files: [{ path: 'main.py', content: 'def foo():\n    pass\n' }] },
  visible_tests: [
    { name: 'test_runs', command: 'echo ok', expected_exit_code: 0 },
    { name: 'test_output', command: 'echo ok', expected_exit_code: 0 },
  ],
});

// Attempt stub — submission is replaced per test
let attemptOverride = null;

const fakeAttemptHigh = new DrillAttempt({
  _id:       attemptId,
  user_id:   userId,
  bundle_id: bundleId,
  status:    'submitted',
  submission: {
    refactored_code: {
      files: [{ path: 'main.py', content: 'def foo():\n    """Refactored."""\n    return None\n' }],
    },
  },
});

ArtifactBundle.findById = () => ({
  lean: () => Promise.resolve(fakeBundle.toObject()),
});

DrillAttempt.findById = () => ({
  lean: () => Promise.resolve(
    attemptOverride !== null ? attemptOverride : fakeAttemptHigh.toObject()
  ),
});

let capturedUpdate = null;
DrillAttempt.findByIdAndUpdate = async (id, update) => {
  capturedUpdate = update;
  return null;
};

// ── Module under test — loaded AFTER stubs are in place ──────────────────────

const { grade } = require('../../coding/services/drillGrader/refactorGrader');

// ─────────────────────────────────────────────────────────────────────────────
// Test A — high score
//   2/2 tests pass → correctness = 10
//   LLM: readability_gain=9, ai_usage_judgment=8
//   overall = round((10*0.5 + 9*0.25 + 8*0.25) * 10) = round(92.5) = 93
// ─────────────────────────────────────────────────────────────────────────────

test('refactorGrader [A]: all tests pass + high LLM rubric → overall_score > 80', async () => {
  STUB_LLM_RESPONSE = {
    content: [{
      text: JSON.stringify({
        rubric: { readability_gain: 9, ai_usage_judgment: 8 },
        what_to_try_next: 'Consider extracting helper.',
      }),
    }],
    _meta: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  };
  sbx.runInTempDir = async () => ({ exit_code: 0, stdout: 'ok', stderr: '', timed_out: false });
  attemptOverride = null;
  capturedUpdate  = null;

  const result = await grade({ drillAttemptId: attemptId });

  assert.ok(
    result.overall_score > 80,
    `expected overall_score > 80, got ${result.overall_score}`
  );
});

test('refactorGrader [A]: saved grade.overall_score > 80', async () => {
  STUB_LLM_RESPONSE = {
    content: [{
      text: JSON.stringify({
        rubric: { readability_gain: 9, ai_usage_judgment: 8 },
        what_to_try_next: 'Consider extracting helper.',
      }),
    }],
    _meta: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  };
  sbx.runInTempDir = async () => ({ exit_code: 0, stdout: 'ok', stderr: '', timed_out: false });
  attemptOverride = null;
  capturedUpdate  = null;

  await grade({ drillAttemptId: attemptId });

  assert.ok(capturedUpdate, 'findByIdAndUpdate should have been called');
  assert.ok(
    capturedUpdate.grade.overall_score > 80,
    `expected saved overall_score > 80, got ${capturedUpdate.grade.overall_score}`
  );
});

test('refactorGrader [A]: status is set to graded', async () => {
  sbx.runInTempDir = async () => ({ exit_code: 0, stdout: 'ok', stderr: '', timed_out: false });
  attemptOverride = null;
  capturedUpdate  = null;

  await grade({ drillAttemptId: attemptId });

  assert.strictEqual(capturedUpdate.status, 'graded');
});

test('refactorGrader [A]: rubric_breakdown has 3 entries (correctness, readability_gain, ai_usage_judgment)', async () => {
  sbx.runInTempDir = async () => ({ exit_code: 0, stdout: 'ok', stderr: '', timed_out: false });
  attemptOverride = null;
  capturedUpdate  = null;

  await grade({ drillAttemptId: attemptId });

  const breakdown = capturedUpdate.grade.rubric_breakdown;
  assert.ok(Array.isArray(breakdown), 'rubric_breakdown must be an array');
  assert.strictEqual(breakdown.length, 3, 'rubric_breakdown should have 3 entries');
  const dims = breakdown.map(e => e.dimension);
  assert.ok(dims.includes('correctness'),       'must include correctness');
  assert.ok(dims.includes('readability_gain'),  'must include readability_gain');
  assert.ok(dims.includes('ai_usage_judgment'), 'must include ai_usage_judgment');
});

test('refactorGrader [A]: what_to_try_next is propagated from LLM response', async () => {
  STUB_LLM_RESPONSE = {
    content: [{
      text: JSON.stringify({
        rubric: { readability_gain: 9, ai_usage_judgment: 8 },
        what_to_try_next: 'Consider extracting helper.',
      }),
    }],
    _meta: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  };
  sbx.runInTempDir = async () => ({ exit_code: 0, stdout: 'ok', stderr: '', timed_out: false });
  attemptOverride = null;
  capturedUpdate  = null;

  await grade({ drillAttemptId: attemptId });

  assert.strictEqual(
    capturedUpdate.grade.what_to_try_next,
    'Consider extracting helper.'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Test B — failing tests → correctness ~0
//   0/2 tests pass → correctness = 0
//   LLM: readability_gain=5, ai_usage_judgment=4
//   overall = round((0*0.5 + 5*0.25 + 4*0.25) * 10) = round(22.5) = 23 < 50
// ─────────────────────────────────────────────────────────────────────────────

test('refactorGrader [B]: sandbox returns non-zero → overall_score < 50', async () => {
  STUB_LLM_RESPONSE = {
    content: [{
      text: JSON.stringify({
        rubric: { readability_gain: 5, ai_usage_judgment: 4 },
        what_to_try_next: 'Your refactored code breaks the tests.',
      }),
    }],
    _meta: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  };
  // Override sandbox to simulate failing tests
  sbx.runInTempDir = async () => ({ exit_code: 1, stdout: '', stderr: 'error', timed_out: false });
  attemptOverride = null;
  capturedUpdate  = null;

  const result = await grade({ drillAttemptId: attemptId });

  assert.ok(
    result.overall_score < 50,
    `expected overall_score < 50 (tests fail), got ${result.overall_score}`
  );
});

test('refactorGrader [B]: saved grade.overall_score < 50 when tests fail', async () => {
  STUB_LLM_RESPONSE = {
    content: [{
      text: JSON.stringify({
        rubric: { readability_gain: 5, ai_usage_judgment: 4 },
        what_to_try_next: 'Your refactored code breaks the tests.',
      }),
    }],
    _meta: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  };
  sbx.runInTempDir = async () => ({ exit_code: 1, stdout: '', stderr: 'error', timed_out: false });
  attemptOverride = null;
  capturedUpdate  = null;

  await grade({ drillAttemptId: attemptId });

  assert.ok(capturedUpdate, 'findByIdAndUpdate should have been called');
  assert.ok(
    capturedUpdate.grade.overall_score < 50,
    `expected saved overall_score < 50, got ${capturedUpdate.grade.overall_score}`
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Test C — no visible_tests in bundle → correctness defaults to 10 (no tests = full credit)
// ─────────────────────────────────────────────────────────────────────────────

test('refactorGrader [C]: bundle with no visible_tests → correctness = 10 (full credit)', async () => {
  STUB_LLM_RESPONSE = {
    content: [{
      text: JSON.stringify({
        rubric: { readability_gain: 7, ai_usage_judgment: 7 },
        what_to_try_next: 'Good start.',
      }),
    }],
    _meta: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  };
  sbx.runInTempDir = async () => ({ exit_code: 0, stdout: 'ok', stderr: '', timed_out: false });

  const emptyTestBundle = new ArtifactBundle({
    _id:                 new mongoose.Types.ObjectId(),
    type:                'drill',
    drill_subtype:       'refactor',
    role_track:          'swe',
    language:            'python',
    difficulty:          'easy',
    time_budget_minutes: 20,
    brief:               'Refactor without tests.',
    acceptance_criteria: [],
    content_hash:        'testhash-refactor-002',
    status:              'active',
    visible_tests:       [],
  });

  const origBundleFindById = ArtifactBundle.findById;
  ArtifactBundle.findById = () => ({ lean: () => Promise.resolve(emptyTestBundle.toObject()) });

  attemptOverride = null;
  capturedUpdate  = null;

  try {
    const result = await grade({ drillAttemptId: attemptId });
    // correctness=10, readability_gain=7, ai_usage_judgment=7
    // overall = round((10*0.5 + 7*0.25 + 7*0.25) * 10) = round(85) = 85
    assert.ok(
      result.overall_score > 80,
      `expected overall_score > 80 with no tests, got ${result.overall_score}`
    );
  } finally {
    ArtifactBundle.findById = origBundleFindById;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Error path tests
// ─────────────────────────────────────────────────────────────────────────────

test('refactorGrader: calls applyPostGradeUpdates after writing grade (regression)', async () => {
  let postGradeCalled = false;
  let postGradeArgs   = null;

  // Stub postGradeHooks BEFORE the grader resolves it via require()
  const postGradeHooksPath = require.resolve('../../coding/services/drillGrader/postGradeHooks');
  delete require.cache[postGradeHooksPath];
  require.cache[postGradeHooksPath] = {
    exports: {
      applyPostGradeUpdates: async (args) => {
        postGradeCalled = true;
        postGradeArgs   = args;
        return { mastery: null, recommendation: null };
      },
    },
    loaded: true,
    id: postGradeHooksPath,
  };

  // Clear the grader from cache so it picks up the fresh postGradeHooks stub
  const graderPath = require.resolve('../../coding/services/drillGrader/refactorGrader');
  delete require.cache[graderPath];
  const { grade: gradeFresh } = require('../../coding/services/drillGrader/refactorGrader');

  STUB_LLM_RESPONSE = {
    content: [{
      text: JSON.stringify({
        rubric: { readability_gain: 9, ai_usage_judgment: 8 },
        what_to_try_next: 'Consider extracting helper.',
      }),
    }],
    _meta: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  };
  sbx.runInTempDir = async () => ({ exit_code: 0, stdout: 'ok', stderr: '', timed_out: false });
  attemptOverride = null;
  capturedUpdate  = null;

  await gradeFresh({ drillAttemptId: attemptId });

  // 2/2 tests pass → correctness=10; readability_gain=9, ai_usage_judgment=8
  // overall = round((10*0.5 + 9*0.25 + 8*0.25) * 10) = round(92.5) = 93
  assert.equal(postGradeCalled, true, 'applyPostGradeUpdates should be called');
  assert.ok(postGradeArgs, 'postGradeArgs should be set');
  assert.equal(postGradeArgs.score, 93, 'score should be passed');
  assert.equal(postGradeArgs.roleTrack, 'swe');
  assert.equal(postGradeArgs.drillSubtype, 'refactor');
});

test('refactorGrader: throws when DrillAttempt not found', async () => {
  const origFindById = DrillAttempt.findById;
  DrillAttempt.findById = () => ({ lean: () => Promise.resolve(null) });

  try {
    await assert.rejects(
      () => grade({ drillAttemptId: new mongoose.Types.ObjectId() }),
      /DrillAttempt .* not found/,
    );
  } finally {
    DrillAttempt.findById = origFindById;
  }
});

test('refactorGrader: throws when ArtifactBundle not found', async () => {
  sbx.runInTempDir = async () => ({ exit_code: 0, stdout: 'ok', stderr: '', timed_out: false });
  attemptOverride = null;

  const origBundleFindById = ArtifactBundle.findById;
  ArtifactBundle.findById = () => ({ lean: () => Promise.resolve(null) });

  try {
    await assert.rejects(
      () => grade({ drillAttemptId: attemptId }),
      /ArtifactBundle .* not found/,
    );
  } finally {
    ArtifactBundle.findById = origBundleFindById;
  }
});

test('refactorGrader: handles LLM response wrapped in ```json fences (regression)', async () => {
  // refactorGrader destructures llmCall at require-time; we mutate
  // STUB_LLM_RESPONSE (which the stub closure closes over) to return
  // fenced JSON. parseLLMJson must strip the fences for the test to pass.
  const origResponse = STUB_LLM_RESPONSE;
  STUB_LLM_RESPONSE = {
    content: [{
      type: 'text',
      text: '```json\n' + JSON.stringify({
        rubric: { readability_gain: 8, ai_usage_judgment: 7 },
        what_to_try_next: 'Extract the helper function for clarity.',
      }) + '\n```',
    }],
    _meta: { provider: 'anthropic', model: 'claude-haiku' },
  };
  sbx.runInTempDir = async () => ({ exit_code: 0, stdout: 'ok', stderr: '', timed_out: false });
  attemptOverride = null;
  capturedUpdate  = null;

  try {
    const result = await grade({ drillAttemptId: attemptId });
    // 2/2 tests pass → correctness = 10; readability_gain=8, ai_usage_judgment=7
    // overall = round((10*0.5 + 8*0.25 + 7*0.25) * 10) = round(87.5) = 88
    assert.strictEqual(result.overall_score, 88, 'fenced JSON: overall_score should be 88');
    assert.ok(capturedUpdate, 'findByIdAndUpdate should have been called');
    assert.strictEqual(capturedUpdate.grade.overall_score, 88, 'fenced JSON: saved overall_score should be 88');
    assert.strictEqual(capturedUpdate.status, 'graded', 'fenced JSON: status should be graded');
  } finally {
    STUB_LLM_RESPONSE = origResponse;
  }
});
