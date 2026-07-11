'use strict';

/**
 * Block 1 (Wave 2) — deterministic scoring.
 *
 * Covers the pure code-side recompute helpers used to make grading
 * deterministic and to catch drift between the LLM's self-reported overall
 * and the weighted recompute:
 *   - scorer.computeOverallScore (capstone Σ dim×10×weight)
 *   - scorer.deriveCorrectnessFromHarness (harness pass-ratio → 0-10)
 *   - rubric.recomputeEqualWeighted (drill prompt/decompose)
 *
 * All pure — no DB / LLM / sandbox.
 */

process.env.OPENAI_API_KEY    = process.env.OPENAI_API_KEY    || 'stub';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub';

const test = require('node:test');
const assert = require('node:assert/strict');

const scorer = require('../../coding/services/capstoneEvaluator/scorer');
const { recomputeEqualWeighted, scoreOf } = require('../../coding/services/drillGrader/rubric');

// ── capstone: computeOverallScore ────────────────────────────────────────────

test('computeOverallScore: weighted sum of six dims × 10', () => {
  // all dims = 8 → 8×10 = 80 regardless of weight split (weights sum to 1).
  const dims = {
    correctness: 8, code_quality: 8, ai_pair_effectiveness: 8,
    verification_discipline: 8, decomposition: 8, reflection_quality: 8,
  };
  assert.equal(scorer.computeOverallScore(dims, scorer.RUBRIC_WEIGHTS), 80);
});

test('computeOverallScore: honours per-dimension weights', () => {
  // correctness (25%) high, everything else 0 → 10×10×0.25 = 25.
  const dims = {
    correctness: 10, code_quality: 0, ai_pair_effectiveness: 0,
    verification_discipline: 0, decomposition: 0, reflection_quality: 0,
  };
  assert.equal(scorer.computeOverallScore(dims, scorer.RUBRIC_WEIGHTS), 25);
});

test('computeOverallScore: missing dims treated as 0', () => {
  assert.equal(scorer.computeOverallScore({}, scorer.RUBRIC_WEIGHTS), 0);
});

// ── capstone: deriveCorrectnessFromHarness ───────────────────────────────────

test('deriveCorrectnessFromHarness: pass-ratio × 10 across visible+hidden', () => {
  const harness = {
    visible: [{ passed: true }, { passed: false }],
    hidden: [{ passed: true }, { passed: true }],
  };
  // 3 of 4 passed → 7.5
  assert.equal(scorer.deriveCorrectnessFromHarness(harness), 7.5);
});

test('deriveCorrectnessFromHarness: all pass → 10, none pass → 0', () => {
  assert.equal(scorer.deriveCorrectnessFromHarness({ visible: [{ passed: true }], hidden: [] }), 10);
  assert.equal(scorer.deriveCorrectnessFromHarness({ visible: [{ passed: false }], hidden: [] }), 0);
});

test('deriveCorrectnessFromHarness: no tests → null (caller keeps LLM value)', () => {
  assert.equal(scorer.deriveCorrectnessFromHarness({ visible: [], hidden: [] }), null);
  assert.equal(scorer.deriveCorrectnessFromHarness({}), null);
});

// ── drift between the LLM number and the code recompute ──────────────────────

test('drift: code recompute diverges from an inflated LLM overall', () => {
  const dims = {
    correctness: 3, code_quality: 5, ai_pair_effectiveness: 2,
    verification_discipline: 5, decomposition: 3, reflection_quality: 4,
  };
  const code = scorer.computeOverallScore(dims, scorer.RUBRIC_WEIGHTS);
  const llmSaid = 72; // model inflated
  assert.ok(Math.abs(code - llmSaid) > 10, `expected drift > 10, code=${code}`);
});

// ── drill: recomputeEqualWeighted ────────────────────────────────────────────

test('recomputeEqualWeighted: mean of dims × 10 (new {score} shape)', () => {
  const rubric = {
    specificity: { score: 8 }, constraints: { score: 7 },
    edge_cases: { score: 7 }, output_fidelity: { score: 8 },
  };
  assert.equal(
    recomputeEqualWeighted(rubric, ['specificity', 'constraints', 'edge_cases', 'output_fidelity']),
    75
  );
});

test('recomputeEqualWeighted: supports legacy plain-number rubric values', () => {
  const rubric = { a: 3, b: 5, c: 2, d: 5 };
  assert.equal(recomputeEqualWeighted(rubric, ['a', 'b', 'c', 'd']), 38);
});

test('scoreOf: extracts score from both shapes, 0 fallback', () => {
  assert.equal(scoreOf({ score: 6 }), 6);
  assert.equal(scoreOf(4), 4);
  assert.equal(scoreOf(undefined), 0);
  assert.equal(scoreOf({}), 0);
});
