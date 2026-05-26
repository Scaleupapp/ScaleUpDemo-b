'use strict';

/**
 * Unit tests for the Joi bundle schema / validateBundle helper.
 * Tests run without HTTP — pure function calls.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateBundle } =
  require('../../coding/services/bundleSchema');

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** A minimal but fully valid drill bundle. */
const VALID_DRILL = {
  type: 'drill',
  drill_subtype: 'prompt',
  role_track: 'swe',
  language: 'python',
  difficulty: 'easy',
  time_budget_minutes: 10,
  brief: 'Write a prompt to ask an LLM to reverse a string.',
  acceptance_criteria: ['Output JSON'],
  reference_solution: { files: [] },
  visible_tests: [],
  hidden_tests: [],
  seeded_mistakes: [],
  rubric_anchors: [],
  expected_meta_skill_signals: {
    good_prompts_look_like: [],
    common_verification_traps: [],
    decomposition_reference: [],
  },
  difficulty_signals: {
    token_count: 50,
    branching_complexity: 1,
    edge_cases: 2,
    known_hard_patterns: [],
  },
  content_hash: 'abc',
};

// ---------------------------------------------------------------------------
// Acceptance tests
// ---------------------------------------------------------------------------

test('bundleSchema: accepts a minimal valid drill bundle', () => {
  const { error } = validateBundle(VALID_DRILL);
  assert.strictEqual(error, undefined, `unexpected validation error: ${error && error.message}`);
});

test('bundleSchema: accepts bundle with optional fields omitted (no interview_parallel, no stack_variant)', () => {
  const bundle = { ...VALID_DRILL };
  delete bundle.interview_parallel;
  delete bundle.stack_variant;
  const { error } = validateBundle(bundle);
  assert.strictEqual(error, undefined, `unexpected error: ${error && error.message}`);
});

test('bundleSchema: accepts bundle with generated_by present', () => {
  const bundle = {
    ...VALID_DRILL,
    generated_by: {
      generator_model: 'claude-3-5-sonnet',
      validator_model: null,
      validated_at: null,
      human_reviewed: false,
    },
  };
  const { error } = validateBundle(bundle);
  assert.strictEqual(error, undefined, `unexpected error: ${error && error.message}`);
});

// ---------------------------------------------------------------------------
// Rejection tests
// ---------------------------------------------------------------------------

test('bundleSchema: rejects bundle missing required field "type"', () => {
  const bundle = { ...VALID_DRILL };
  delete bundle.type;
  const { error } = validateBundle(bundle);
  assert.ok(error, 'expected a validation error when "type" is missing');
  assert.ok(
    error.details.some(d => d.path.includes('type') || d.message.includes('type')),
    `expected error to mention "type", got: ${error.message}`,
  );
});

test('bundleSchema: rejects bundle with invalid role_track value "unknown"', () => {
  const bundle = { ...VALID_DRILL, role_track: 'unknown' };
  const { error } = validateBundle(bundle);
  assert.ok(error, 'expected a validation error for unknown role_track');
  assert.ok(
    error.details.some(d => d.path.includes('role_track') || d.message.includes('role_track')),
    `expected error to mention "role_track", got: ${error.message}`,
  );
});

test('bundleSchema: rejects bundle with invalid drill_subtype "magic"', () => {
  const bundle = { ...VALID_DRILL, drill_subtype: 'magic' };
  const { error } = validateBundle(bundle);
  assert.ok(error, 'expected a validation error for invalid drill_subtype');
  assert.ok(
    error.details.some(d => d.path.includes('drill_subtype') || d.message.includes('drill_subtype')),
    `expected error to mention "drill_subtype", got: ${error.message}`,
  );
});

test('bundleSchema: rejects bundle with extra unknown top-level field', () => {
  const bundle = { ...VALID_DRILL, totally_unknown_field: 'should fail' };
  const { error } = validateBundle(bundle);
  assert.ok(error, 'expected a validation error for unknown top-level field');
});

test('bundleSchema: rejects drill bundle missing required field "brief"', () => {
  const bundle = { ...VALID_DRILL };
  delete bundle.brief;
  const { error } = validateBundle(bundle);
  assert.ok(error, 'expected a validation error when "brief" is missing');
});

test('bundleSchema: rejects bundle missing "content_hash"', () => {
  const bundle = { ...VALID_DRILL };
  delete bundle.content_hash;
  const { error } = validateBundle(bundle);
  assert.ok(error, 'expected a validation error when "content_hash" is missing');
});

test('bundleSchema: rejects bundle with invalid difficulty value', () => {
  const bundle = { ...VALID_DRILL, difficulty: 'extreme' };
  const { error } = validateBundle(bundle);
  assert.ok(error, 'expected a validation error for invalid difficulty');
});
