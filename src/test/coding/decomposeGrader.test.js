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
let STUB_LLM_RESPONSE = {
  content: [{
    text: JSON.stringify({
      overall_score: 88,
      rubric: {
        granularity:               9,
        ordering:                  9,
        verification_checkpoints:  8,
        ai_handoff_appropriateness: 9,
      },
      what_to_try_next: 'Add explicit acceptance check after step 3.',
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

// ─────────────────────────────────────────────────────────────────────────────
// Test A — high score: 5 well-ordered steps with verification checkpoints
// Mock LLM returns overall_score: 88
// ─────────────────────────────────────────────────────────────────────────────

test('decomposeGrader [A]: grade() returns overall_score === 88', async () => {
  STUB_LLM_RESPONSE = {
    content: [{
      text: JSON.stringify({
        overall_score: 88,
        rubric: {
          granularity:               9,
          ordering:                  9,
          verification_checkpoints:  8,
          ai_handoff_appropriateness: 9,
        },
        what_to_try_next: 'Add explicit acceptance check after step 3.',
      }),
    }],
    _meta: { provider: 'anthropic', model: 'claude-haiku' },
  };
  attemptOverride = null;
  capturedUpdate  = null;

  const result = await grade({ drillAttemptId: attemptId });
  assert.strictEqual(result.overall_score, 88, `expected overall_score 88, got ${result.overall_score}`);
});

test('decomposeGrader [A]: saved grade.overall_score === 88', async () => {
  STUB_LLM_RESPONSE = {
    content: [{
      text: JSON.stringify({
        overall_score: 88,
        rubric: {
          granularity:               9,
          ordering:                  9,
          verification_checkpoints:  8,
          ai_handoff_appropriateness: 9,
        },
        what_to_try_next: 'Add explicit acceptance check after step 3.',
      }),
    }],
    _meta: { provider: 'anthropic', model: 'claude-haiku' },
  };
  attemptOverride = null;
  capturedUpdate  = null;

  await grade({ drillAttemptId: attemptId });
  assert.ok(capturedUpdate, 'findByIdAndUpdate should have been called');
  assert.strictEqual(capturedUpdate.grade.overall_score, 88);
});

test('decomposeGrader [A]: status set to graded', async () => {
  STUB_LLM_RESPONSE = {
    content: [{
      text: JSON.stringify({
        overall_score: 88,
        rubric: {
          granularity:               9,
          ordering:                  9,
          verification_checkpoints:  8,
          ai_handoff_appropriateness: 9,
        },
        what_to_try_next: 'Add explicit acceptance check after step 3.',
      }),
    }],
    _meta: { provider: 'anthropic', model: 'claude-haiku' },
  };
  attemptOverride = null;
  capturedUpdate  = null;

  await grade({ drillAttemptId: attemptId });
  assert.strictEqual(capturedUpdate.status, 'graded');
});

test('decomposeGrader [A]: rubric_breakdown has 4 entries', async () => {
  STUB_LLM_RESPONSE = {
    content: [{
      text: JSON.stringify({
        overall_score: 88,
        rubric: {
          granularity:               9,
          ordering:                  9,
          verification_checkpoints:  8,
          ai_handoff_appropriateness: 9,
        },
        what_to_try_next: 'Add explicit acceptance check after step 3.',
      }),
    }],
    _meta: { provider: 'anthropic', model: 'claude-haiku' },
  };
  attemptOverride = null;
  capturedUpdate  = null;

  await grade({ drillAttemptId: attemptId });
  const breakdown = capturedUpdate.grade.rubric_breakdown;
  assert.ok(Array.isArray(breakdown), 'rubric_breakdown must be an array');
  assert.strictEqual(breakdown.length, 4, `expected 4 rubric entries, got ${breakdown.length}`);
});

test('decomposeGrader [A]: rubric_breakdown contains all 4 dimensions', async () => {
  STUB_LLM_RESPONSE = {
    content: [{
      text: JSON.stringify({
        overall_score: 88,
        rubric: {
          granularity:               9,
          ordering:                  9,
          verification_checkpoints:  8,
          ai_handoff_appropriateness: 9,
        },
        what_to_try_next: 'Add explicit acceptance check after step 3.',
      }),
    }],
    _meta: { provider: 'anthropic', model: 'claude-haiku' },
  };
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
  STUB_LLM_RESPONSE = {
    content: [{
      text: JSON.stringify({
        overall_score: 88,
        rubric: {
          granularity:               9,
          ordering:                  9,
          verification_checkpoints:  8,
          ai_handoff_appropriateness: 9,
        },
        what_to_try_next: 'Add explicit acceptance check after step 3.',
      }),
    }],
    _meta: { provider: 'anthropic', model: 'claude-haiku' },
  };
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
          granularity:               3,
          ordering:                  5,
          verification_checkpoints:  2,
          ai_handoff_appropriateness: 5,
        },
        what_to_try_next: 'Steps too vague — break further.',
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
  assert.strictEqual(result.overall_score, 42, `expected overall_score 42, got ${result.overall_score}`);
});

test('decomposeGrader [B]: saved grade.overall_score === 42', async () => {
  STUB_LLM_RESPONSE = {
    content: [{
      text: JSON.stringify({
        overall_score: 42,
        rubric: {
          granularity:               3,
          ordering:                  5,
          verification_checkpoints:  2,
          ai_handoff_appropriateness: 5,
        },
        what_to_try_next: 'Steps too vague — break further.',
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
  assert.strictEqual(capturedUpdate.grade.overall_score, 42);
});

// ─────────────────────────────────────────────────────────────────────────────
// Error path tests
// ─────────────────────────────────────────────────────────────────────────────

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
