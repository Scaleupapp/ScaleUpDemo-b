require('dotenv').config();
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'stub';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'stub';
// Disable the answer-side judge here — these tests exercise the grader dispatch.
process.env.GRADE_JUDGE_SAMPLE_RATE = '0';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { dispatchDrillGrade, drillGraderQueue } = require('../../coding/workers/drillGrader.worker');
const promptGrader   = require('../../coding/services/drillGrader/promptGrader');
const verifyGrader   = require('../../coding/services/drillGrader/verifyGrader');
const decomposeGrader = require('../../coding/services/drillGrader/decomposeGrader');
const refactorGrader  = require('../../coding/services/drillGrader/refactorGrader');

// ── dispatch: prompt ────────────────────────────────────────────────────────
test('dispatchDrillGrade routes "prompt" to promptGrader.grade', async () => {
  let callArgs = null;
  const original = promptGrader.grade;
  promptGrader.grade = async (args) => { callArgs = args; return { stub: true }; };

  await dispatchDrillGrade({ drillAttemptId: 'attempt-prompt-1', drill_subtype: 'prompt' });

  assert.deepEqual(callArgs, { drillAttemptId: 'attempt-prompt-1' });
  promptGrader.grade = original;
});

// ── dispatch: verify ────────────────────────────────────────────────────────
test('dispatchDrillGrade routes "verify" to verifyGrader.grade', async () => {
  let callArgs = null;
  const original = verifyGrader.grade;
  verifyGrader.grade = async (args) => { callArgs = args; return { stub: true }; };

  await dispatchDrillGrade({ drillAttemptId: 'attempt-verify-1', drill_subtype: 'verify' });

  assert.deepEqual(callArgs, { drillAttemptId: 'attempt-verify-1' });
  verifyGrader.grade = original;
});

// ── dispatch: decompose ─────────────────────────────────────────────────────
test('dispatchDrillGrade routes "decompose" to decomposeGrader.grade', async () => {
  let callArgs = null;
  const original = decomposeGrader.grade;
  decomposeGrader.grade = async (args) => { callArgs = args; return { stub: true }; };

  await dispatchDrillGrade({ drillAttemptId: 'attempt-decompose-1', drill_subtype: 'decompose' });

  assert.deepEqual(callArgs, { drillAttemptId: 'attempt-decompose-1' });
  decomposeGrader.grade = original;
});

// ── dispatch: refactor ──────────────────────────────────────────────────────
test('dispatchDrillGrade routes "refactor" to refactorGrader.grade', async () => {
  let callArgs = null;
  const original = refactorGrader.grade;
  refactorGrader.grade = async (args) => { callArgs = args; return { stub: true }; };

  await dispatchDrillGrade({ drillAttemptId: 'attempt-refactor-1', drill_subtype: 'refactor' });

  assert.deepEqual(callArgs, { drillAttemptId: 'attempt-refactor-1' });
  refactorGrader.grade = original;
});

// ── dispatch: unknown subtype ───────────────────────────────────────────────
test('dispatchDrillGrade throws on unknown drill_subtype', async () => {
  await assert.rejects(
    () => dispatchDrillGrade({ drillAttemptId: 'x', drill_subtype: 'unknown' }),
    { message: 'Unknown drill_subtype: unknown' }
  );
});

// ── queue retry policy ──────────────────────────────────────────────────────
test('drillGraderQueue has defaultJobOptions.attempts === 3', () => {
  assert.equal(drillGraderQueue.defaultJobOptions.attempts, 3);
});

test('drillGraderQueue has exponential backoff with delay 2000', () => {
  const backoff = drillGraderQueue.defaultJobOptions.backoff;
  assert.equal(backoff.type, 'exponential');
  assert.equal(backoff.delay, 2000);
});
