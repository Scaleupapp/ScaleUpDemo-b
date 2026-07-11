'use strict';

/**
 * Unit tests for src/coding/services/drillGrader/promptGrader.js
 *
 * Mongoose model methods (DrillAttempt.findById, DrillAttempt.findByIdAndUpdate,
 * ArtifactBundle.findById) are manually stubbed — no DB connection required.
 * llmRouter.llmCall is replaced with a deterministic stub before the module
 * under test is loaded.
 */

process.env.OPENAI_API_KEY     = process.env.OPENAI_API_KEY     || 'stub';
process.env.ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY  || 'stub';

const test   = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

// ── deterministic LLM stub ────────────────────────────────────────────────────

let STUB_LLM_RESPONSE = {
  content: [{
    text: JSON.stringify({
      overall_score: 78,
      rubric: {
        specificity:     { score: 8, feedback: 'Good level of specificity.' },
        constraints:     { score: 7, feedback: 'Missing output format constraint.' },
        edge_cases:      { score: 7, feedback: 'Does not handle empty input.' },
        output_fidelity: { score: 8, feedback: 'Would produce correct output.' },
      },
      what_to_try_next: 'Add explicit format constraints.',
      what_you_missed: [],
    }),
  }],
  _meta: { provider: 'anthropic', model: 'claude-haiku' },
};

// Patch llmRouter before anything else requires it
const llmRouter = require('../../coding/services/llmRouter');
llmRouter.llmCall = async () => STUB_LLM_RESPONSE;

// ── model stubs ───────────────────────────────────────────────────────────────

const { ArtifactBundle, DrillAttempt } = require('../../coding/models');

// Build minimal documents using Mongoose constructors so ObjectId fields are real
const bundleId  = new mongoose.Types.ObjectId();
const attemptId = new mongoose.Types.ObjectId();
const userId    = new mongoose.Types.ObjectId();

const fakeBundle = new ArtifactBundle({
  _id:                 bundleId,
  type:                'drill',
  drill_subtype:       'prompt',
  role_track:          'swe',
  language:            'javascript',
  difficulty:          'easy',
  time_budget_minutes: 20,
  brief:               'Write a function that sums two numbers.',
  acceptance_criteria: ['Returns correct integer', 'Handles negative numbers'],
  content_hash:        'testhash001',
  status:              'active',
});

const fakeAttempt = new DrillAttempt({
  _id:       attemptId,
  user_id:   userId,
  bundle_id: bundleId,
  status:    'submitted',
  submission: {
    prompt_text: 'Write a function that sums two numbers.',
  },
});

// Captured update payload — filled by the stub
let capturedUpdate = null;

// Override model static methods with stubs
ArtifactBundle.findById = (id) => ({
  lean: () => Promise.resolve(fakeBundle.toObject()),
});

DrillAttempt.findById = (id) => ({
  lean: () => Promise.resolve(fakeAttempt.toObject()),
});

DrillAttempt.findByIdAndUpdate = async (id, update) => {
  capturedUpdate = update;
  return null; // return value is not used by the grader
};

// ── module under test — loaded AFTER stubs are in place ──────────────────────

const { grade } = require('../../coding/services/drillGrader/promptGrader');

// ── tests ─────────────────────────────────────────────────────────────────────

// Code-side recompute: dims 8,7,7,8 → mean 7.5 → 75 (NOT the LLM's self-reported 78).
test('promptGrader: grade() calls llmCall and returns code-recomputed score', async () => {
  const result = await grade({ drillAttemptId: attemptId });
  assert.strictEqual(result.overall_score, 75, 'overall_score should be code-recomputed 75');
  assert.strictEqual(result.llm_overall_score, 78, 'llm_overall_score retains the LLM number');
});

test('promptGrader: grade() writes status=graded and code-recomputed overall_score back to DrillAttempt', async () => {
  // Reset and re-run so capturedUpdate is fresh
  capturedUpdate = null;
  await grade({ drillAttemptId: attemptId });

  assert.ok(capturedUpdate, 'findByIdAndUpdate should have been called');
  assert.strictEqual(capturedUpdate.status, 'graded', 'status should be graded');
  assert.strictEqual(capturedUpdate.grade.overall_score, 75, 'grade.overall_score should be 75');
  assert.strictEqual(capturedUpdate.grade.integrity_confidence, 'unverified', 'drill integrity is unverified, not high');
});

test('promptGrader: grade() rubric_breakdown has 4 entries', async () => {
  capturedUpdate = null;
  await grade({ drillAttemptId: attemptId });

  const breakdown = capturedUpdate.grade.rubric_breakdown;
  assert.ok(Array.isArray(breakdown), 'rubric_breakdown should be an array');
  assert.strictEqual(breakdown.length, 4, 'rubric_breakdown should have 4 entries');
});

test('promptGrader: grade() rubric_breakdown entries have dimension + score + feedback', async () => {
  capturedUpdate = null;
  await grade({ drillAttemptId: attemptId });

  const breakdown = capturedUpdate.grade.rubric_breakdown;
  for (const entry of breakdown) {
    assert.ok(typeof entry.dimension === 'string', `dimension must be a string, got ${typeof entry.dimension}`);
    assert.ok(typeof entry.score    === 'number',  `score must be a number, got ${typeof entry.score}`);
    assert.ok('feedback' in entry,                  'entry must have a feedback key');
  }
});

test('promptGrader: grade() sets what_to_try_next from LLM response', async () => {
  capturedUpdate = null;
  await grade({ drillAttemptId: attemptId });

  assert.strictEqual(
    capturedUpdate.grade.what_to_try_next,
    'Add explicit format constraints.',
  );
});

test('promptGrader: grade() throws when DrillAttempt not found', async () => {
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

test('promptGrader: grade() throws when ArtifactBundle not found', async () => {
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

test('promptGrader: calls applyPostGradeUpdates after writing grade (regression)', async () => {
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
  const graderPath = require.resolve('../../coding/services/drillGrader/promptGrader');
  delete require.cache[graderPath];
  const { grade: gradeFresh } = require('../../coding/services/drillGrader/promptGrader');

  capturedUpdate = null;
  STUB_LLM_RESPONSE = {
    content: [{
      text: JSON.stringify({
        overall_score: 78,
        rubric: {
          specificity:     { score: 8, feedback: 'Good.' },
          constraints:     { score: 7, feedback: 'Missing format.' },
          edge_cases:      { score: 7, feedback: 'Missing empty input.' },
          output_fidelity: { score: 8, feedback: 'Correct output.' },
        },
        what_to_try_next: 'Add explicit format constraints.',
        what_you_missed: [],
      }),
    }],
    _meta: { provider: 'anthropic', model: 'claude-haiku' },
  };

  await gradeFresh({ drillAttemptId: attemptId });

  assert.equal(postGradeCalled, true, 'applyPostGradeUpdates should be called');
  assert.ok(postGradeArgs, 'postGradeArgs should be set');
  assert.equal(postGradeArgs.score, 75, 'code-recomputed score should be passed');
  assert.equal(postGradeArgs.roleTrack, 'swe');
  assert.equal(postGradeArgs.drillSubtype, 'prompt');
});

test('promptGrader: grade() saves what_you_missed=[] when LLM returns empty array', async () => {
  capturedUpdate = null;
  await grade({ drillAttemptId: attemptId });

  assert.ok(Array.isArray(capturedUpdate.grade.what_you_missed), 'what_you_missed must be an array');
  assert.strictEqual(capturedUpdate.grade.what_you_missed.length, 0, 'what_you_missed should be empty when LLM returns []');
});

test('promptGrader: grade() saves what_you_missed entries when LLM returns them', async () => {
  const origResponse = STUB_LLM_RESPONSE;
  STUB_LLM_RESPONSE = {
    content: [{
      text: JSON.stringify({
        overall_score: 60,
        rubric: {
          specificity:     { score: 6, feedback: 'Too vague.' },
          constraints:     { score: 5, feedback: 'No constraints declared.' },
          edge_cases:      { score: 5, feedback: 'No edge cases.' },
          output_fidelity: { score: 6, feedback: 'May produce wrong output.' },
        },
        what_to_try_next: 'Add explicit constraints.',
        what_you_missed: [
          { title: "Didn't specify error handling", detail: 'No error handling specified.', reference: 'Specify: skip silently' },
        ],
      }),
    }],
    _meta: { provider: 'anthropic', model: 'claude-haiku' },
  };
  capturedUpdate = null;

  try {
    await grade({ drillAttemptId: attemptId });
    assert.ok(Array.isArray(capturedUpdate.grade.what_you_missed), 'what_you_missed must be an array');
    assert.strictEqual(capturedUpdate.grade.what_you_missed.length, 1, 'what_you_missed should have 1 entry');
    assert.ok(capturedUpdate.grade.what_you_missed[0].title, 'entry must have title');
    assert.ok(capturedUpdate.grade.what_you_missed[0].detail, 'entry must have detail');
  } finally {
    STUB_LLM_RESPONSE = origResponse;
  }
});

test('promptGrader: rubric_breakdown entries have per-criterion feedback from new { score, feedback } shape', async () => {
  capturedUpdate = null;
  await grade({ drillAttemptId: attemptId });

  const breakdown = capturedUpdate.grade.rubric_breakdown;
  for (const entry of breakdown) {
    assert.ok(typeof entry.feedback === 'string' && entry.feedback.length > 0,
      `feedback must be non-empty for dimension ${entry.dimension}`);
  }
});

test('promptGrader: handles LLM response wrapped in ```json fences (regression)', async () => {
  const origResponse = STUB_LLM_RESPONSE;
  STUB_LLM_RESPONSE = {
    content: [{
      type: 'text',
      text: '```json\n' + JSON.stringify({
        overall_score: 65,
        rubric: {
          specificity:     { score: 7, feedback: 'Decent.' },
          constraints:     { score: 6, feedback: 'Missing length constraint.' },
          edge_cases:      { score: 6, feedback: 'Edge cases not addressed.' },
          output_fidelity: { score: 7, feedback: 'Mostly correct.' },
        },
        what_to_try_next: 'Be more specific about edge cases.',
        what_you_missed: [],
      }) + '\n```',
    }],
    _meta: { provider: 'anthropic', model: 'claude-haiku' },
  };

  capturedUpdate = null;

  try {
    const result = await grade({ drillAttemptId: attemptId });
    assert.strictEqual(result.overall_score, 65, 'fenced JSON: overall_score should be 65');
    assert.ok(capturedUpdate, 'findByIdAndUpdate should have been called');
    assert.strictEqual(capturedUpdate.grade.overall_score, 65, 'fenced JSON: saved overall_score should be 65');
  } finally {
    STUB_LLM_RESPONSE = origResponse;
  }
});
