'use strict';

/**
 * Block 2 (Wave 2) — answer-side LLM-as-judge on grades.
 *
 * The judge LLM and the re-grade fn are dependency-injected, so no network.
 */

process.env.OPENAI_API_KEY    = process.env.OPENAI_API_KEY    || 'stub';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub';

const test = require('node:test');
const assert = require('node:assert/strict');

const svc = require('../../services/grading/gradeJudgeService');

function stubJudge(overall, extra = {}) {
  return async () => ({ overall, concurs: extra.concurs, notes: 'ok', ...extra });
}

const baseArgs = {
  engine: 'interview',
  evidence: 'transcript…',
  rubric: { communication: 1 },
};

test('reconcile: judge concurs (within 15) ⇒ no review, keeps grade', async () => {
  const r = await svc.reconcile(
    { ...baseArgs, graderResult: { overall: 80 }, sampleRate: 1 },
    { judgeLlm: stubJudge(72) }
  );
  assert.equal(r.sampled, true);
  assert.equal(r.needsReview, false);
  assert.equal(r.regraded, false);
  assert.equal(r.finalOverall, 80);
  assert.equal(r.disagreement, 8);
});

test('reconcile: divergent but re-grade converges ⇒ average, no review', async () => {
  // grader=80, judge=60 (Δ20 > 15). Re-grade returns 66 (Δ vs judge = 6 ≤ 15) ⇒
  // converged; final = round((80+66)/2) = 73.
  const r = await svc.reconcile(
    { ...baseArgs, graderResult: { overall: 80 }, regrade: async () => ({ overall: 66 }), sampleRate: 1 },
    { judgeLlm: stubJudge(60) }
  );
  assert.equal(r.needsReview, false);
  assert.equal(r.regraded, true);
  assert.equal(r.finalOverall, 73);
});

test('reconcile: divergent and re-grade still divergent ⇒ needsReview', async () => {
  // grader=90, judge=50 (Δ40). Re-grade=88 (Δ vs judge=38 > 15) ⇒ still divergent.
  const r = await svc.reconcile(
    { ...baseArgs, graderResult: { overall: 90 }, regrade: async () => ({ overall: 88 }), sampleRate: 1 },
    { judgeLlm: stubJudge(50) }
  );
  assert.equal(r.needsReview, true);
  assert.equal(r.regraded, true);
});

test('reconcile: divergent with no regrade fn ⇒ needsReview', async () => {
  const r = await svc.reconcile(
    { ...baseArgs, graderResult: { overall: 90 }, sampleRate: 1 },
    { judgeLlm: stubJudge(50) }
  );
  assert.equal(r.needsReview, true);
  assert.equal(r.regraded, false);
});

test('reconcile: sampling gate skips when rng ≥ rate', async () => {
  let called = false;
  const r = await svc.reconcile(
    { ...baseArgs, graderResult: { overall: 90 }, sampleRate: 0.5 },
    { rng: () => 0.9, judgeLlm: async () => { called = true; return { overall: 10 }; } }
  );
  assert.equal(r.sampled, false);
  assert.equal(r.needsReview, false);
  assert.equal(called, false, 'judge must not be called when sampled out');
});

test('reconcile: sampleRate 0 always skips', async () => {
  const r = await svc.reconcile(
    { ...baseArgs, graderResult: { overall: 90 }, sampleRate: 0 },
    { judgeLlm: stubJudge(10) }
  );
  assert.equal(r.sampled, false);
});

test('reconcile: judge failure fails open (no review, keeps grade)', async () => {
  const r = await svc.reconcile(
    { ...baseArgs, graderResult: { overall: 90 }, sampleRate: 1 },
    { judgeLlm: async () => { throw new Error('boom'); } }
  );
  assert.equal(r.sampled, true);
  assert.equal(r.needsReview, false);
  assert.equal(r.finalOverall, 90);
});

test('reconcile: judge returns non-numeric ⇒ fail open', async () => {
  const r = await svc.reconcile(
    { ...baseArgs, graderResult: { overall: 90 }, sampleRate: 1 },
    { judgeLlm: async () => ({ overall: 'not-a-number' }) }
  );
  assert.equal(r.needsReview, false);
  assert.equal(r.finalOverall, 90);
});

test('reconcile: regrade throws ⇒ needsReview (do not silently trust first)', async () => {
  const r = await svc.reconcile(
    { ...baseArgs, graderResult: { overall: 90 }, regrade: async () => { throw new Error('x'); }, sampleRate: 1 },
    { judgeLlm: stubJudge(50) }
  );
  assert.equal(r.needsReview, true);
});

test('sampleRateFromEnv: defaults to 1.0 and clamps', () => {
  const { sampleRateFromEnv } = svc._helpers;
  const orig = process.env.GRADE_JUDGE_SAMPLE_RATE;
  delete process.env.GRADE_JUDGE_SAMPLE_RATE;
  assert.equal(sampleRateFromEnv(), 1.0);
  process.env.GRADE_JUDGE_SAMPLE_RATE = '0.3';
  assert.equal(sampleRateFromEnv(), 0.3);
  process.env.GRADE_JUDGE_SAMPLE_RATE = '5';
  assert.equal(sampleRateFromEnv(), 1);
  if (orig === undefined) delete process.env.GRADE_JUDGE_SAMPLE_RATE;
  else process.env.GRADE_JUDGE_SAMPLE_RATE = orig;
});
