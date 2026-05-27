'use strict';

/**
 * Unit tests for coding-practice Mongoose models.
 * Uses validateSync() — no DB connection required.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ArtifactBundle,
  DrillAttempt,
  MetaSkillMastery,
  DifficultyState,
  HumanReviewQueue,
  EvaluationAnchor,
} = require('../../coding/models');

// ---------------------------------------------------------------------------
// ArtifactBundle
// ---------------------------------------------------------------------------

test('ArtifactBundle: validateSync surfaces error when type is missing', () => {
  const doc = new ArtifactBundle({
    // type omitted
    role_track: 'swe',
    language: 'python',
    difficulty: 'easy',
    brief: 'Fix the bug.',
    time_budget_minutes: 20,
    content_hash: 'abc123',
  });
  const err = doc.validateSync();
  assert.ok(err, 'expected a validation error');
  assert.ok(err.errors['type'], 'expected error on "type" field');
});

test('ArtifactBundle: validateSync surfaces error when role_track is missing', () => {
  const doc = new ArtifactBundle({
    type: 'drill',
    // role_track omitted
    language: 'python',
    difficulty: 'easy',
    brief: 'Fix the bug.',
    time_budget_minutes: 20,
    content_hash: 'abc123',
  });
  const err = doc.validateSync();
  assert.ok(err, 'expected a validation error');
  assert.ok(err.errors['role_track'], 'expected error on "role_track" field');
});

test('ArtifactBundle: validateSync surfaces error when language is missing', () => {
  const doc = new ArtifactBundle({
    type: 'drill',
    role_track: 'swe',
    // language omitted
    difficulty: 'easy',
    brief: 'Fix the bug.',
    time_budget_minutes: 20,
    content_hash: 'abc123',
  });
  const err = doc.validateSync();
  assert.ok(err, 'expected a validation error');
  assert.ok(err.errors['language'], 'expected error on "language" field');
});

test('ArtifactBundle: validateSync surfaces error when difficulty is missing', () => {
  const doc = new ArtifactBundle({
    type: 'drill',
    role_track: 'swe',
    language: 'python',
    // difficulty omitted
    brief: 'Fix the bug.',
    time_budget_minutes: 20,
    content_hash: 'abc123',
  });
  const err = doc.validateSync();
  assert.ok(err, 'expected a validation error');
  assert.ok(err.errors['difficulty'], 'expected error on "difficulty" field');
});

test('ArtifactBundle: validateSync surfaces error when brief is missing', () => {
  const doc = new ArtifactBundle({
    type: 'drill',
    role_track: 'swe',
    language: 'python',
    difficulty: 'easy',
    // brief omitted
    time_budget_minutes: 20,
    content_hash: 'abc123',
  });
  const err = doc.validateSync();
  assert.ok(err, 'expected a validation error');
  assert.ok(err.errors['brief'], 'expected error on "brief" field');
});

test('ArtifactBundle: accepts a valid drill bundle with all required fields populated', () => {
  const doc = new ArtifactBundle({
    type: 'drill',
    drill_subtype: 'prompt',
    role_track: 'swe',
    language: 'javascript',
    difficulty: 'medium',
    brief: 'Refactor this function to avoid mutation.',
    time_budget_minutes: 30,
    content_hash: 'deadbeef01',
    status: 'active',
  });
  const err = doc.validateSync();
  assert.strictEqual(err, undefined, `unexpected validation error: ${err}`);
  assert.strictEqual(doc.type, 'drill');
  assert.strictEqual(doc.role_track, 'swe');
  assert.strictEqual(doc.language, 'javascript');
  assert.strictEqual(doc.difficulty, 'medium');
  assert.strictEqual(doc.version, 1);
  assert.strictEqual(doc.status, 'active');
});

// ---------------------------------------------------------------------------
// DrillAttempt
// ---------------------------------------------------------------------------

test('DrillAttempt: validateSync surfaces error when user_id is missing', () => {
  const mongoose = require('mongoose');
  const doc = new DrillAttempt({
    // user_id omitted
    bundle_id: new mongoose.Types.ObjectId(),
  });
  const err = doc.validateSync();
  assert.ok(err, 'expected a validation error');
  assert.ok(err.errors['user_id'], 'expected error on "user_id" field');
});

test('DrillAttempt: validateSync surfaces error when bundle_id is missing', () => {
  const mongoose = require('mongoose');
  const doc = new DrillAttempt({
    user_id: new mongoose.Types.ObjectId(),
    // bundle_id omitted
  });
  const err = doc.validateSync();
  assert.ok(err, 'expected a validation error');
  assert.ok(err.errors['bundle_id'], 'expected error on "bundle_id" field');
});

test('DrillAttempt: accepts valid doc with user_id, bundle_id, and drill_subtype', () => {
  const mongoose = require('mongoose');
  const doc = new DrillAttempt({
    user_id: new mongoose.Types.ObjectId(),
    bundle_id: new mongoose.Types.ObjectId(),
    drill_subtype: 'prompt',
  });
  const err = doc.validateSync();
  assert.strictEqual(err, undefined, `unexpected validation error: ${err}`);
  assert.strictEqual(doc.status, 'scheduled');
  assert.strictEqual(doc.is_calibration, false);
});

test('DrillAttempt requires drill_subtype enum value', () => {
  const mongoose = require('mongoose');
  const attempt = new DrillAttempt({
    user_id: new mongoose.Types.ObjectId(),
    bundle_id: new mongoose.Types.ObjectId(),
    // drill_subtype intentionally missing
  });
  const err = attempt.validateSync();
  assert.ok(err, 'expected a validation error');
  assert.ok(err.errors.drill_subtype, 'expected drill_subtype to be required');
});

test('DrillAttempt accepts valid drill_subtype enum value', () => {
  const mongoose = require('mongoose');
  const attempt = new DrillAttempt({
    user_id: new mongoose.Types.ObjectId(),
    bundle_id: new mongoose.Types.ObjectId(),
    drill_subtype: 'prompt',
  });
  const err = attempt.validateSync();
  assert.ok(!err || !err.errors.drill_subtype, 'should accept prompt');
});

test('DrillAttempt rejects invalid drill_subtype', () => {
  const mongoose = require('mongoose');
  const attempt = new DrillAttempt({
    user_id: new mongoose.Types.ObjectId(),
    bundle_id: new mongoose.Types.ObjectId(),
    drill_subtype: 'invalid_subtype',
  });
  const err = attempt.validateSync();
  assert.ok(err, 'expected a validation error');
  assert.ok(err.errors.drill_subtype, 'expected enum violation');
});

// ---------------------------------------------------------------------------
// MetaSkillMastery
// ---------------------------------------------------------------------------

test('MetaSkillMastery: accepts valid doc with 4 axes', () => {
  const mongoose = require('mongoose');
  const doc = new MetaSkillMastery({
    user_id: new mongoose.Types.ObjectId(),
    role_track: 'swe',
    axes: {
      prompting: 60,
      verification: 55,
      decomposition: 40,
      refactoring: 70,
    },
    confidence: 0.8,
    attempt_count: 5,
  });
  const err = doc.validateSync();
  assert.strictEqual(err, undefined, `unexpected validation error: ${err}`);
  assert.strictEqual(doc.axes.prompting, 60);
  assert.strictEqual(doc.axes.verification, 55);
  assert.strictEqual(doc.axes.decomposition, 40);
  assert.strictEqual(doc.axes.refactoring, 70);
});

test('MetaSkillMastery: axes default to 0 when not supplied', () => {
  const mongoose = require('mongoose');
  const doc = new MetaSkillMastery({
    user_id: new mongoose.Types.ObjectId(),
    role_track: 'ds',
  });
  const err = doc.validateSync();
  assert.strictEqual(err, undefined, `unexpected validation error: ${err}`);
  assert.strictEqual(doc.axes.prompting, 0);
  assert.strictEqual(doc.axes.verification, 0);
  assert.strictEqual(doc.axes.decomposition, 0);
  assert.strictEqual(doc.axes.refactoring, 0);
});

// ---------------------------------------------------------------------------
// DifficultyState
// ---------------------------------------------------------------------------

test('DifficultyState: accepts valid doc with current_difficulty and recommendation_history', () => {
  const mongoose = require('mongoose');
  const doc = new DifficultyState({
    user_id: new mongoose.Types.ObjectId(),
    role_track: 'ai_eng',
    current_difficulty: 'medium',
    recommendation_history: [
      { recommended: 'easy', reason: 'low score', accepted: true, timestamp: new Date() },
      { recommended: 'medium', reason: 'improved', accepted: true, timestamp: new Date() },
    ],
  });
  const err = doc.validateSync();
  assert.strictEqual(err, undefined, `unexpected validation error: ${err}`);
  assert.strictEqual(doc.current_difficulty, 'medium');
  assert.strictEqual(doc.recommendation_history.length, 2);
});

test('DifficultyState: validateSync surfaces error when current_difficulty is missing', () => {
  const mongoose = require('mongoose');
  const doc = new DifficultyState({
    user_id: new mongoose.Types.ObjectId(),
    role_track: 'swe',
    // current_difficulty omitted
  });
  const err = doc.validateSync();
  assert.ok(err, 'expected a validation error');
  assert.ok(err.errors['current_difficulty'], 'expected error on "current_difficulty" field');
});

// ---------------------------------------------------------------------------
// HumanReviewQueue
// ---------------------------------------------------------------------------

test('HumanReviewQueue: accepts valid doc with bundle_id, reason, and status', () => {
  const mongoose = require('mongoose');
  const doc = new HumanReviewQueue({
    bundle_id: new mongoose.Types.ObjectId(),
    reason: 'Rubric anchors look off',
    status: 'pending',
    validator_errors: ['missing acceptance criteria'],
  });
  const err = doc.validateSync();
  assert.strictEqual(err, undefined, `unexpected validation error: ${err}`);
  assert.strictEqual(doc.status, 'pending');
  assert.strictEqual(doc.reason, 'Rubric anchors look off');
  assert.strictEqual(doc.validator_errors.length, 1);
});

test('HumanReviewQueue: status defaults to pending', () => {
  const mongoose = require('mongoose');
  const doc = new HumanReviewQueue({
    bundle_id: new mongoose.Types.ObjectId(),
    reason: 'Needs review',
  });
  const err = doc.validateSync();
  assert.strictEqual(err, undefined, `unexpected validation error: ${err}`);
  assert.strictEqual(doc.status, 'pending');
});

// ---------------------------------------------------------------------------
// EvaluationAnchor
// ---------------------------------------------------------------------------

test('EvaluationAnchor: accepts valid doc with bundle_id, anchor_id, and expected_score', () => {
  const mongoose = require('mongoose');
  const doc = new EvaluationAnchor({
    bundle_id: new mongoose.Types.ObjectId(),
    anchor_id: 'anchor-001',
    expected_score: 85,
    observed_scores: [
      { score: 83, drift: -2, observed_at: new Date(), grader_model: 'claude-3' },
    ],
  });
  const err = doc.validateSync();
  assert.strictEqual(err, undefined, `unexpected validation error: ${err}`);
  assert.strictEqual(doc.anchor_id, 'anchor-001');
  assert.strictEqual(doc.expected_score, 85);
  assert.strictEqual(doc.observed_scores.length, 1);
});

test('EvaluationAnchor: validateSync surfaces error when expected_score is missing', () => {
  const mongoose = require('mongoose');
  const doc = new EvaluationAnchor({
    bundle_id: new mongoose.Types.ObjectId(),
    anchor_id: 'anchor-002',
    // expected_score omitted
  });
  const err = doc.validateSync();
  assert.ok(err, 'expected a validation error');
  assert.ok(err.errors['expected_score'], 'expected error on "expected_score" field');
});
