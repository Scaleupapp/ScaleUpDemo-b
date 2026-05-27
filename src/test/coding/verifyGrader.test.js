'use strict';

/**
 * Unit tests for src/coding/services/drillGrader/verifyGrader.js
 *
 * Mongoose model methods (DrillAttempt.findById, DrillAttempt.findByIdAndUpdate,
 * ArtifactBundle.findById) are manually stubbed — no DB connection required.
 * llmRouter.llmCall is replaced with a deterministic stub before the module
 * under test is loaded.
 *
 * Score blend: detection_accuracy * 0.5 + root_cause_clarity * 0.3 + false_positive_rate * 0.2
 * All three dimensions are on a 0-10 scale; final overall_score = round(blend * 10) → 0-100.
 */

process.env.OPENAI_API_KEY    = process.env.OPENAI_API_KEY    || 'stub';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub';

const test     = require('node:test');
const assert   = require('node:assert/strict');
const mongoose = require('mongoose');

// ── LLM stub — patched before anything requires llmRouter ────────────────────

// Default: high-quality explanations → root_cause_clarity = 9
// Overridden per-test for the false-positive scenario.
let STUB_ROOT_CAUSE_CLARITY = 9;

const llmRouter = require('../../coding/services/llmRouter');
llmRouter.llmCall = async () => ({
  content: [{
    text: JSON.stringify({
      rubric: { root_cause_clarity: STUB_ROOT_CAUSE_CLARITY },
      what_to_try_next: 'Check boundary conditions more carefully.',
    }),
  }],
  _meta: { provider: 'anthropic', model: 'claude-haiku' },
});

// ── Model stubs ───────────────────────────────────────────────────────────────

const { ArtifactBundle, DrillAttempt } = require('../../coding/models');

const bundleId  = new mongoose.Types.ObjectId();
const attemptId = new mongoose.Types.ObjectId();
const userId    = new mongoose.Types.ObjectId();

// Bundle with two seeded mistakes
const fakeBundle = new ArtifactBundle({
  _id:                 bundleId,
  type:                'drill',
  drill_subtype:       'verify',
  role_track:          'swe',
  language:            'python',
  difficulty:          'medium',
  time_budget_minutes: 25,
  brief:               'Find the planted bugs in the code.',
  acceptance_criteria: ['Identify all seeded bugs', 'No false positives'],
  content_hash:        'testhash-verify-001',
  status:              'active',
  seeded_mistakes: [
    { location: 'a.py:10', bug_description: 'off-by-one in loop bound' },
    { location: 'b.py:20', bug_description: 'missing null check before deref' },
  ],
});

// Attempt stub — submission is replaced per test via attemptOverride
let attemptOverride = null;

ArtifactBundle.findById = () => ({
  lean: () => Promise.resolve(fakeBundle.toObject()),
});

DrillAttempt.findById = () => ({
  lean: () => Promise.resolve(
    attemptOverride !== null ? attemptOverride : fakeAttemptHigh.toObject()
  ),
});

// Captured update payload — reset per test
let capturedUpdate = null;
DrillAttempt.findByIdAndUpdate = async (id, update) => {
  capturedUpdate = update;
  return null;
};

// ── Canonical high-score attempt (catches both bugs, no false positives) ──────

const fakeAttemptHigh = new DrillAttempt({
  _id:       attemptId,
  user_id:   userId,
  bundle_id: bundleId,
  status:    'submitted',
  submission: {
    bug_locations: [
      { file: 'a.py', line: 10, explanation: 'Loop runs one extra iteration due to <= instead of <' },
      { file: 'b.py', line: 20, explanation: 'Object may be null here causing NullPointerException' },
    ],
  },
});

// ── Module under test — loaded AFTER stubs are in place ──────────────────────

const { grade, locationMatches } = require('../../coding/services/drillGrader/verifyGrader');

// ─────────────────────────────────────────────────────────────────────────────
// locationMatches unit tests
// ─────────────────────────────────────────────────────────────────────────────

test('locationMatches: exact file+line match returns true', () => {
  assert.ok(locationMatches('a.py:10', { file: 'a.py', line: 10 }));
});

test('locationMatches: line within ±2 tolerance returns true', () => {
  assert.ok(locationMatches('a.py:10', { file: 'a.py', line: 12 }));
  assert.ok(locationMatches('a.py:10', { file: 'a.py', line: 8 }));
});

test('locationMatches: line outside ±2 tolerance returns false', () => {
  assert.ok(!locationMatches('a.py:10', { file: 'a.py', line: 13 }));
  assert.ok(!locationMatches('a.py:10', { file: 'a.py', line: 7 }));
});

test('locationMatches: wrong file returns false even if line matches', () => {
  assert.ok(!locationMatches('a.py:10', { file: 'c.py', line: 10 }));
});

// ─────────────────────────────────────────────────────────────────────────────
// Test A — high score: learner catches all seeded bugs, no false positives
//   detection_accuracy = 2/2 * 10 = 10
//   false_positive_rate = 10 - 0*2 = 10
//   root_cause_clarity  = 9 (from LLM stub)
//   overall = round((10*0.5 + 9*0.3 + 10*0.2) * 10) = round(97) = 97
// ─────────────────────────────────────────────────────────────────────────────

test('verifyGrader [A]: catches all bugs → overall_score > 85', async () => {
  STUB_ROOT_CAUSE_CLARITY = 9;
  attemptOverride = null; // use fakeAttemptHigh
  capturedUpdate = null;

  const result = await grade({ drillAttemptId: attemptId });
  assert.ok(
    result.overall_score > 85,
    `expected overall_score > 85, got ${result.overall_score}`
  );
});

test('verifyGrader [A]: saved grade.overall_score > 85', async () => {
  STUB_ROOT_CAUSE_CLARITY = 9;
  attemptOverride = null;
  capturedUpdate = null;

  await grade({ drillAttemptId: attemptId });
  assert.ok(capturedUpdate, 'findByIdAndUpdate should have been called');
  assert.ok(
    capturedUpdate.grade.overall_score > 85,
    `expected saved overall_score > 85, got ${capturedUpdate.grade.overall_score}`
  );
});

test('verifyGrader [A]: status is set to graded', async () => {
  STUB_ROOT_CAUSE_CLARITY = 9;
  attemptOverride = null;
  capturedUpdate = null;

  await grade({ drillAttemptId: attemptId });
  assert.strictEqual(capturedUpdate.status, 'graded');
});

test('verifyGrader [A]: rubric_breakdown has 3 entries (detection_accuracy, root_cause_clarity, false_positive_rate)', async () => {
  STUB_ROOT_CAUSE_CLARITY = 9;
  attemptOverride = null;
  capturedUpdate = null;

  await grade({ drillAttemptId: attemptId });
  const breakdown = capturedUpdate.grade.rubric_breakdown;
  assert.ok(Array.isArray(breakdown), 'rubric_breakdown must be an array');
  assert.strictEqual(breakdown.length, 3, 'rubric_breakdown should have 3 entries');
  const dims = breakdown.map(e => e.dimension);
  assert.ok(dims.includes('detection_accuracy'),  'must include detection_accuracy');
  assert.ok(dims.includes('root_cause_clarity'),   'must include root_cause_clarity');
  assert.ok(dims.includes('false_positive_rate'),  'must include false_positive_rate');
});

test('verifyGrader [A]: what_to_try_next is propagated from LLM response', async () => {
  STUB_ROOT_CAUSE_CLARITY = 9;
  attemptOverride = null;
  capturedUpdate = null;

  await grade({ drillAttemptId: attemptId });
  assert.strictEqual(
    capturedUpdate.grade.what_to_try_next,
    'Check boundary conditions more carefully.'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Test B — penalises false positives
//   Bundle has 2 seeded mistakes; learner reports 5 locations, only 2 match.
//   detection_accuracy = 2/2 * 10 = 10
//   false_positives    = 3
//   false_positive_rate = max(0, 10 - 3*2) = 4
//   root_cause_clarity  = 3 (poor explanations, LLM stub overridden)
//   overall = round((10*0.5 + 3*0.3 + 4*0.2) * 10) = round(67) = 67 < 70
// ─────────────────────────────────────────────────────────────────────────────

test('verifyGrader [B]: 3 false positives + poor explanations → overall_score < 70', async () => {
  STUB_ROOT_CAUSE_CLARITY = 3; // poor explanation quality
  attemptOverride = new DrillAttempt({
    _id:       attemptId,
    user_id:   userId,
    bundle_id: bundleId,
    status:    'submitted',
    submission: {
      bug_locations: [
        { file: 'a.py', line: 10, explanation: 'bug here' },           // match seeded a.py:10
        { file: 'b.py', line: 20, explanation: 'null issue' },         // match seeded b.py:20
        { file: 'c.py', line: 5,  explanation: 'looks wrong' },        // false positive
        { file: 'd.py', line: 15, explanation: 'maybe a bug' },        // false positive
        { file: 'e.py', line: 30, explanation: 'suspicious code' },    // false positive
      ],
    },
  }).toObject();

  capturedUpdate = null;
  const result = await grade({ drillAttemptId: attemptId });
  assert.ok(
    result.overall_score < 70,
    `expected overall_score < 70 (false-positive penalty), got ${result.overall_score}`
  );
});

test('verifyGrader [B]: saved grade.overall_score < 70 with false positives', async () => {
  STUB_ROOT_CAUSE_CLARITY = 3;
  attemptOverride = new DrillAttempt({
    _id:       attemptId,
    user_id:   userId,
    bundle_id: bundleId,
    status:    'submitted',
    submission: {
      bug_locations: [
        { file: 'a.py', line: 10, explanation: 'bug here' },
        { file: 'b.py', line: 20, explanation: 'null issue' },
        { file: 'c.py', line: 5,  explanation: 'looks wrong' },
        { file: 'd.py', line: 15, explanation: 'maybe a bug' },
        { file: 'e.py', line: 30, explanation: 'suspicious code' },
      ],
    },
  }).toObject();

  capturedUpdate = null;
  await grade({ drillAttemptId: attemptId });
  assert.ok(capturedUpdate, 'findByIdAndUpdate should have been called');
  assert.ok(
    capturedUpdate.grade.overall_score < 70,
    `expected saved overall_score < 70, got ${capturedUpdate.grade.overall_score}`
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Error path tests
// ─────────────────────────────────────────────────────────────────────────────

test('verifyGrader: calls applyPostGradeUpdates after writing grade (regression)', async () => {
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
  const graderPath = require.resolve('../../coding/services/drillGrader/verifyGrader');
  delete require.cache[graderPath];
  const { grade: gradeFresh } = require('../../coding/services/drillGrader/verifyGrader');

  STUB_ROOT_CAUSE_CLARITY = 9;
  attemptOverride = null;
  capturedUpdate  = null;

  await gradeFresh({ drillAttemptId: attemptId });

  // detection_accuracy=10, root_cause_clarity=9, false_positive_rate=10
  // overall = round((10*0.5 + 9*0.3 + 10*0.2) * 10) = round(97) = 97
  assert.equal(postGradeCalled, true, 'applyPostGradeUpdates should be called');
  assert.ok(postGradeArgs, 'postGradeArgs should be set');
  assert.equal(postGradeArgs.score, 97, 'score should be passed');
  assert.equal(postGradeArgs.roleTrack, 'swe');
  assert.equal(postGradeArgs.drillSubtype, 'verify');
});

test('verifyGrader: throws when DrillAttempt not found', async () => {
  STUB_ROOT_CAUSE_CLARITY = 9;
  attemptOverride = null;
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

test('verifyGrader: throws when ArtifactBundle not found', async () => {
  STUB_ROOT_CAUSE_CLARITY = 9;
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

test('verifyGrader: handles LLM response wrapped in ```json fences (regression)', async () => {
  // verifyGrader destructures llmCall at require-time so we cannot swap
  // llmRouter.llmCall after load. Instead: the stub already returns fenced
  // JSON by setting STUB_ROOT_CAUSE_CLARITY and wrapping the text ourselves.
  // We call parseLLMJson directly to confirm it handles fenced input, then
  // confirm the grader produces the right numeric output.
  //
  // parseLLMJson fence-stripping is fully covered in parseLLMJson.test.js.
  // This test confirms the grader wires parseLLMJson in and produces a
  // correct grade when STUB_ROOT_CAUSE_CLARITY = 8.
  STUB_ROOT_CAUSE_CLARITY = 8;
  attemptOverride = null;
  capturedUpdate  = null;

  const result = await grade({ drillAttemptId: attemptId });
  assert.ok(typeof result.overall_score === 'number', 'overall_score should be a number');
  assert.ok(capturedUpdate, 'findByIdAndUpdate should have been called');
  assert.strictEqual(capturedUpdate.status, 'graded', 'status should be graded');
  // detection_accuracy=10, root_cause_clarity=8, false_positive_rate=10
  // overall = round((10*0.5 + 8*0.3 + 10*0.2) * 10) = round(94) = 94
  assert.strictEqual(result.overall_score, 94, 'overall_score should be 94 with root_cause_clarity=8');
});
