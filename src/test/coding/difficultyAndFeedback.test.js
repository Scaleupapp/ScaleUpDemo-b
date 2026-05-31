'use strict';

/**
 * Unit tests for the difficulty-conformance + grading-feedback additions.
 *
 * Pure functions only — no DB / LLM. Covers:
 *   - contentGenerator.checkDifficultyConformance (soft floor per difficulty)
 *   - contentGenerator.difficultyContractBlock (prompt scaffolding)
 *   - scorer.normalizeFeedback (backfills per-dimension feedback + rationale)
 */

require('dotenv').config();
process.env.OPENAI_API_KEY    = process.env.OPENAI_API_KEY    || 'stub';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const {
  checkDifficultyConformance,
  difficultyContractBlock,
  DIFFICULTY_SPEC,
} = require('../../coding/services/contentGenerator');
const { normalizeFeedback, DIMENSIONS } = require('../../coding/services/capstoneEvaluator/scorer');

// ── checkDifficultyConformance ────────────────────────────────────────────────

test('hard capstone below edge-case + hidden-test floor → warnings', () => {
  const res = checkDifficultyConformance({
    type: 'capstone',
    difficulty: 'hard',
    difficulty_signals: { edge_cases: 4 },
    hidden_tests: [{}, {}],
  });
  assert.strictEqual(res.ok, false);
  assert.ok(res.warnings.some((w) => /edge_cases=4 < 10/.test(w)));
  assert.ok(res.warnings.some((w) => /hidden_tests=2 < 5/.test(w)));
});

test('easy capstone meeting floor → ok, no warnings', () => {
  const res = checkDifficultyConformance({
    type: 'capstone',
    difficulty: 'easy',
    difficulty_signals: { edge_cases: 3 },
    hidden_tests: [{}, {}, {}],
  });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.warnings, []);
});

test('unknown difficulty → no-op ok', () => {
  const res = checkDifficultyConformance({ type: 'capstone', difficulty: 'legendary' });
  assert.strictEqual(res.ok, true);
});

test('difficulty floors increase strictly easy < medium < hard', () => {
  assert.ok(DIFFICULTY_SPEC.easy.min_edge_cases < DIFFICULTY_SPEC.medium.min_edge_cases);
  assert.ok(DIFFICULTY_SPEC.medium.min_edge_cases < DIFFICULTY_SPEC.hard.min_edge_cases);
  assert.ok(DIFFICULTY_SPEC.easy.min_hidden_tests <= DIFFICULTY_SPEC.hard.min_hidden_tests);
});

test('difficultyContractBlock names the difficulty and a measurable floor', () => {
  const block = difficultyContractBlock('hard');
  assert.match(block, /DIFFICULTY CONTRACT/);
  assert.match(block, /Hard/);
  assert.match(block, /10/); // the hard edge-case floor
});

// ── scorer.normalizeFeedback ──────────────────────────────────────────────────

test('normalizeFeedback backfills all six dimensions with {why,to_improve}', () => {
  const { dimension_feedback } = normalizeFeedback({
    dimension_feedback: { correctness: { why: 'two hidden tests failed', to_improve: 'handle empty input' } },
    evidence_notes: 'global note',
  });
  for (const d of DIMENSIONS) {
    assert.ok(dimension_feedback[d], `missing feedback for ${d}`);
    assert.strictEqual(typeof dimension_feedback[d].why, 'string');
    assert.strictEqual(typeof dimension_feedback[d].to_improve, 'string');
  }
  assert.strictEqual(dimension_feedback.correctness.why, 'two hidden tests failed');
  // unfilled dimensions backfill to empty strings, never undefined
  assert.strictEqual(dimension_feedback.decomposition.why, '');
});

test('normalizeFeedback falls back overall_rationale to evidence_notes', () => {
  const { overall_rationale } = normalizeFeedback({ evidence_notes: 'the global blob' });
  assert.strictEqual(overall_rationale, 'the global blob');
});

test('normalizeFeedback prefers explicit overall_rationale', () => {
  const { overall_rationale } = normalizeFeedback({
    overall_rationale: 'correctness is 25% and hidden tests failed',
    evidence_notes: 'blob',
  });
  assert.strictEqual(overall_rationale, 'correctness is 25% and hidden tests failed');
});
