'use strict';

/**
 * Unit tests for src/coding/services/drillGrader/decomposeGrader.js
 *
 * Mongoose model methods (DrillAttempt.findById, DrillAttempt.findByIdAndUpdate,
 * ArtifactBundle.findById) are manually stubbed — no DB connection required.
 * llmRouter.llmCall is replaced with a deterministic stub before the module
 * under test is loaded.
 */

process.env.OPENAI_API_KEY    = process.env.OPENAI_API_KEY    || 'stub';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub';

const test     = require('node:test');
const assert   = require('node:assert/strict');
const mongoose = require('mongoose');

// ── LLM stub — patched before anything requires llmRouter ────────────────────

// Mutable so individual tests can override the response.
// Uses new { score, feedback } rubric shape.
let STUB_LLM_RESPONSE = {
  content: [{
    text: JSON.stringify({
      overall_score: 88,
      rubric: {
        granularity:               { score: 9, feedback: 'Steps are well-sized.' },
        ordering:                  { score: 9, feedback: 'Dependencies respected.' },
        verification_checkpoints:  { score: 8, feedback: 'Most steps have checks.' },
        ai_handoff_appropriateness: { score: 9, feedback: 'Good handoff clarity.' },
      },
      what_to_try_next: 'Add explicit acceptance check after step 3.',
      what_you_missed: [],
    }),
  }],
  _meta: { provider: 'anthropic', model: 'claude-haiku' },
};

const llmRouter = require('../../coding/services/llmRouter');
llmRouter.llmCall = async () => STUB_LLM_RESPONSE;

// ── Model stubs ───────────────────────────────────────────────────────────────

const { ArtifactBundle, DrillAttempt } = require('../../coding/models');

const bundleId  = new mongoose.Types.ObjectId();
const attemptId = new mongoose.Types.ObjectId();
const userId    = new mongoose.Types.ObjectId();

// Bundle with decomposition_reference signals
const fakeBundle = new ArtifactBundle({
  _id:                 bundleId,
  type:                'drill',
  drill_subtype:       'decompose',
  role_track:          'swe',
  language:            'javascript',
  difficulty:          'medium',
  time_budget_minutes: 25,
  brief:               'Build a feature that imports CSV data into a database.',
  acceptance_criteria: ['All rows imported', 'Duplicates skipped', 'Errors logged'],
  content_hash:        'testhash-decompose-001',
  status:              'active',
  expected_meta_skill_signals: {
    decomposition_reference: [
      'Step 1: Parse the CSV file and validate headers.',
      'Step 2: Deduplicate rows against existing DB records.',
      'Step 3: Insert valid rows in a transaction.',
      'Step 4: Log any skipped or errored rows.',
      'Step 5: Return import summary to caller.',
    ],
  },
});

// Attempt override — reset per test
let attemptOverride = null;

// High-score attempt: 5 well-ordered steps with step + rationale
const fakeAttemptHigh = new DrillAttempt({
  _id:       attemptId,
  user_id:   userId,
  bundle_id: bundleId,
  status:    'submitted',
  submission: {
    decomposition_steps: [
      { step: 'Parse CSV and validate headers.',         rationale: 'Fail fast on bad input.' },
      { step: 'Deduplicate rows vs. DB.',                rationale: 'Avoid constraint violations.' },
      { step: 'Insert valid rows in a DB transaction.',  rationale: 'Atomicity guarantees.' },
      { step: 'Log skipped/errored rows.',               rationale: 'Observability requirement.' },
      { step: 'Return import summary.',                  rationale: 'Caller needs counts.' },
    ],
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

const { grade } = require('../../coding/services/drillGrader/decomposeGrader');

// Helper that builds a high-score LLM stub response
function highScoreResponse(overrides = {}) {
  return {
    content: [{
      text: JSON.stringify({
        overall_score: 88,
        rubric: {
          granularity:               { score: 9, feedback: 'Well-sized steps.' },
          ordering:                  { score: 9, feedback: 'Good ordering.' },
          verification_checkpoints:  { score: 8, feedback: 'Most steps checked.' },
          ai_handoff_appropriateness: { score: 9, feedback: 'Clear handoffs.' },
        },
        what_to_try_next: 'Add explicit acceptance check after step 3.',
        what_you_missed: [],
        ...overrides,
      }),
    }],
    _meta: { provider: 'anthropic', model: 'claude-haiku' },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test A — high score: 5 well-ordered steps with verification checkpoints
// Mock LLM returns overall_score: 88
// ─────────────────────────────────────────────────────────────────────────────

test('decomposeGrader [A]: grade() returns overall_score === 88', async () => {
  STUB_LLM_RESPONSE = highScoreResponse();
  attemptOverride = null;
  capturedUpdate  = null;

  const result = await grade({ drillAttemptId: attemptId });
  assert.strictEqual(result.overall_score, 88, `expected overall_score 88, got ${result.overall_score}`);
});

test('decomposeGrader [A]: saved grade.overall_score === 88', async () => {
  STUB_LLM_RESPONSE = highScoreResponse();
  attemptOverride = null;
  capturedUpdate  = null;

  await grade({ drillAttemptId: attemptId });
  assert.ok(capturedUpdate, 'findByIdAndUpdate should have been called');
  assert.strictEqual(capturedUpdate.grade.overall_score, 88);
});

test('decomposeGrader [A]: status set to graded', async () => {
  STUB_LLM_RESPONSE = highScoreResponse();
  attemptOverride = null;
  capturedUpdate  = null;

  await grade({ drillAttemptId: attemptId });
  assert.strictEqual(capturedUpdate.status, 'graded');
});

test('decomposeGrader [A]: rubric_breakdown has 4 entries', async () => {
  STUB_LLM_RESPONSE = highScoreResponse();
  attemptOverride = null;
  capturedUpdate  = null;

  await grade({ drillAttemptId: attemptId });
  const breakdown = capturedUpdate.grade.rubric_breakdown;
  assert.ok(Array.isArray(breakdown), 'rubric_breakdown must be an array');
  assert.strictEqual(breakdown.length, 4, `expected 4 rubric entries, got ${breakdown.length}`);
});

test('decomposeGrader [A]: rubric_breakdown contains all 4 dimensions', async () => {
  STUB_LLM_RESPONSE = highScoreResponse();
  attemptOverride = null;
  capturedUpdate  = null;

  await grade({ drillAttemptId: attemptId });
  const dims = capturedUpdate.grade.rubric_breakdown.map(e => e.dimension);
  assert.ok(dims.includes('granularity'),               'must include granularity');
  assert.ok(dims.includes('ordering'),                  'must include ordering');
  assert.ok(dims.includes('verification_checkpoints'),  'must include verification_checkpoints');
  assert.ok(dims.includes('ai_handoff_appropriateness'), 'must include ai_handoff_appropriateness');
});

test('decomposeGrader [A]: what_to_try_next propagated from LLM response', async () => {
  STUB_LLM_RESPONSE = highScoreResponse();
  attemptOverride = null;
  capturedUpdate  = null;

  await grade({ drillAttemptId: attemptId });
  assert.strictEqual(
    capturedUpdate.grade.what_to_try_next,
    'Add explicit acceptance check after step 3.',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Test B — low score: 2 vague steps
// Mock LLM returns overall_score: 42
// ─────────────────────────────────────────────────────────────────────────────

test('decomposeGrader [B]: grade() returns overall_score === 42 for 2 vague steps', async () => {
  STUB_LLM_RESPONSE = {
    content: [{
      text: JSON.stringify({
        overall_score: 42,
        rubric: {
          granularity:               { score: 3, feedback: 'Steps too vague.' },
          ordering:                  { score: 5, feedback: 'Ordering acceptable.' },
          verification_checkpoints:  { score: 2, feedback: 'No verification steps.' },
          ai_handoff_appropriateness: { score: 5, feedback: 'Unclear handoffs.' },
        },
        what_to_try_next: 'Steps too vague — break further.',
        what_you_missed: [
          { title: 'Missing step: Deduplication', detail: 'No dedup step included.', reference: 'Step 2: Deduplicate rows' },
        ],
      }),
    }],
    _meta: { provider: 'anthropic', model: 'claude-haiku' },
  };
  attemptOverride = new DrillAttempt({
    _id:       attemptId,
    user_id:   userId,
    bundle_id: bundleId,
    status:    'submitted',
    submission: {
      decomposition_steps: [
        { step: 'Do the import.', rationale: '' },
        { step: 'Handle errors.',  rationale: '' },
      ],
    },
  }).toObject();
  capturedUpdate = null;

  const result = await grade({ drillAttemptId: attemptId });
  // Code-side recompute: dims 3,5,2,5 → mean 3.75 → 38 (LLM self-reported 42 — drift caught).
  assert.strictEqual(result.overall_score, 38, `expected code-recomputed 38, got ${result.overall_score}`);
  assert.strictEqual(result.llm_overall_score, 42, 'llm_overall_score retains the LLM number');
});

test('decomposeGrader [B]: saved grade.overall_score === 42', async () => {
  STUB_LLM_RESPONSE = {
    content: [{
      text: JSON.stringify({
        overall_score: 42,
        rubric: {
          granularity:               { score: 3, feedback: 'Steps too vague.' },
          ordering:                  { score: 5, feedback: 'Acceptable.' },
          verification_checkpoints:  { score: 2, feedback: 'No verification.' },
          ai_handoff_appropriateness: { score: 5, feedback: 'Unclear.' },
        },
        what_to_try_next: 'Steps too vague — break further.',
        what_you_missed: [],
      }),
    }],
    _meta: { provider: 'anthropic', model: 'claude-haiku' },
  };
  attemptOverride = new DrillAttempt({
    _id:       attemptId,
    user_id:   userId,
    bundle_id: bundleId,
    status:    'submitted',
    submission: {
      decomposition_steps: [
        { step: 'Do the import.', rationale: '' },
        { step: 'Handle errors.',  rationale: '' },
      ],
    },
  }).toObject();
  capturedUpdate = null;

  await grade({ drillAttemptId: attemptId });
  assert.ok(capturedUpdate, 'findByIdAndUpdate should have been called');
  assert.strictEqual(capturedUpdate.grade.overall_score, 38);
  assert.strictEqual(capturedUpdate.grade.integrity_confidence, 'unverified');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test C — what_you_missed
// ─────────────────────────────────────────────────────────────────────────────

test('decomposeGrader: what_you_missed is saved as empty array when LLM returns []', async () => {
  STUB_LLM_RESPONSE = highScoreResponse({ what_you_missed: [] });
  attemptOverride = null;
  capturedUpdate  = null;

  await grade({ drillAttemptId: attemptId });
  assert.ok(Array.isArray(capturedUpdate.grade.what_you_missed), 'what_you_missed must be an array');
  assert.strictEqual(capturedUpdate.grade.what_you_missed.length, 0, 'should be empty');
});

test('decomposeGrader: what_you_missed entries saved when LLM returns them', async () => {
  STUB_LLM_RESPONSE = highScoreResponse({
    overall_score: 60,
    what_you_missed: [
      { title: 'Missing step: API contract definition', detail: 'No contract step.', reference: 'Step 1 — Define defaults' },
    ],
  });
  attemptOverride = null;
  capturedUpdate  = null;

  await grade({ drillAttemptId: attemptId });
  assert.ok(Array.isArray(capturedUpdate.grade.what_you_missed), 'what_you_missed must be an array');
  assert.strictEqual(capturedUpdate.grade.what_you_missed.length, 1, 'should have 1 entry');
  assert.ok(capturedUpdate.grade.what_you_missed[0].title, 'entry must have title');
});

test('decomposeGrader: rubric_breakdown entries have per-criterion feedback', async () => {
  STUB_LLM_RESPONSE = highScoreResponse();
  attemptOverride = null;
  capturedUpdate  = null;

  await grade({ drillAttemptId: attemptId });
  const breakdown = capturedUpdate.grade.rubric_breakdown;
  for (const entry of breakdown) {
    assert.ok(typeof entry.feedback === 'string' && entry.feedback.length > 0,
      `feedback must be non-empty for dimension ${entry.dimension}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Error path tests
// ─────────────────────────────────────────────────────────────────────────────

test('decomposeGrader: calls applyPostGradeUpdates after writing grade (regression)', async () => {
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
  const graderPath = require.resolve('../../coding/services/drillGrader/decomposeGrader');
  delete require.cache[graderPath];
  const { grade: gradeFresh } = require('../../coding/services/drillGrader/decomposeGrader');

  STUB_LLM_RESPONSE = highScoreResponse();
  attemptOverride = null;
  capturedUpdate  = null;

  await gradeFresh({ drillAttemptId: attemptId });

  assert.equal(postGradeCalled, true, 'applyPostGradeUpdates should be called');
  assert.ok(postGradeArgs, 'postGradeArgs should be set');
  assert.equal(postGradeArgs.score, 88, 'score should be passed');
  assert.equal(postGradeArgs.roleTrack, 'swe');
  assert.equal(postGradeArgs.drillSubtype, 'decompose');
});

test('decomposeGrader: throws when DrillAttempt not found', async () => {
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

test('decomposeGrader: throws when ArtifactBundle not found', async () => {
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

test('decomposeGrader: handles LLM response wrapped in ```json fences (regression)', async () => {
  attemptOverride = null;

  STUB_LLM_RESPONSE = {
    content: [{
      type: 'text',
      text: '```json\n' + JSON.stringify({
        overall_score: 72,
        rubric: {
          granularity:               { score: 7, feedback: 'Decent granularity.' },
          ordering:                  { score: 8, feedback: 'Good ordering.' },
          verification_checkpoints:  { score: 6, feedback: 'Some checks missing.' },
          ai_handoff_appropriateness: { score: 7, feedback: 'Mostly clear.' },
        },
        what_to_try_next: 'Add a verification step after each handoff.',
        what_you_missed: [],
      }) + '\n```',
    }],
    _meta: { provider: 'anthropic', model: 'claude-haiku' },
  };

  capturedUpdate = null;

  const result = await grade({ drillAttemptId: attemptId });
  // dims 7,8,6,7 → mean 7 → 70 (LLM self-reported 72).
  assert.strictEqual(result.overall_score, 70, 'fenced JSON: code-recomputed overall_score should be 70');
  assert.ok(capturedUpdate, 'findByIdAndUpdate should have been called');
  assert.strictEqual(capturedUpdate.grade.overall_score, 70, 'fenced JSON: saved overall_score should be 70');
});
