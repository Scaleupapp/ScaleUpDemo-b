'use strict';
/**
 * Unit tests for src/services/institution/assessment/assessmentService.js
 *
 * All deps injected — no real DB.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createAssessment, releaseAssessment, listAssessments, getAssessment } = require('../../services/institution/assessment/assessmentService');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAssessmentDoc(overrides = {}) {
  const base = {
    _id: 'a1',
    type: 'mcq',
    status: 'configured',
    institutionId: 'i1',
    cohortId: 'c1',
    config: {
      mcq: {
        questions: [{ questionText: 'Q1' }, { questionText: 'Q2' }],
        totalQuestions: 2,
      },
    },
    save: async function () { return this; },
  };
  return { ...base, ...overrides };
}

const SCOPE = { institutionId: 'i1' };

// ---------------------------------------------------------------------------
// createAssessment
// ---------------------------------------------------------------------------

test('createAssessment passes scope + payload to Assessment.create', async () => {
  let created = null;
  const deps = {
    Assessment: {
      create: async (d) => { created = d; return { _id: 'new1', ...d }; },
    },
  };
  const result = await createAssessment(SCOPE, { cohortId: 'c1', type: 'mcq', title: 'T', createdBy: 'u1' }, deps);
  assert.strictEqual(created.institutionId, 'i1');
  assert.strictEqual(created.type, 'mcq');
  assert.strictEqual(result._id, 'new1');
});

// ---------------------------------------------------------------------------
// releaseAssessment — happy path (mcq WITH questions)
// ---------------------------------------------------------------------------

test('releaseAssessment succeeds for mcq with questions', async () => {
  const doc = makeAssessmentDoc();
  const deps = { Assessment: { findOne: async () => doc } };
  const result = await releaseAssessment(SCOPE, 'a1', 'user1', deps);
  assert.strictEqual(result.status, 'released');
  assert.strictEqual(result.releasedBy, 'user1');
  assert.ok(result.releasedAt instanceof Date);
});

// ---------------------------------------------------------------------------
// releaseAssessment — NO_QUESTIONS gate
// ---------------------------------------------------------------------------

test('releaseAssessment throws NO_QUESTIONS for mcq with empty questions array', async () => {
  const doc = makeAssessmentDoc({ config: { mcq: { questions: [], totalQuestions: 0 } } });
  const deps = { Assessment: { findOne: async () => doc } };
  await assert.rejects(
    () => releaseAssessment(SCOPE, 'a1', 'user1', deps),
    (err) => {
      assert.strictEqual(err.message, 'NO_QUESTIONS');
      return true;
    }
  );
});

test('releaseAssessment throws NO_QUESTIONS for mcq with undefined questions', async () => {
  const doc = makeAssessmentDoc({ config: { mcq: { totalQuestions: 0 } } });
  const deps = { Assessment: { findOne: async () => doc } };
  await assert.rejects(
    () => releaseAssessment(SCOPE, 'a1', 'user1', deps),
    /NO_QUESTIONS/
  );
});

test('releaseAssessment throws NO_QUESTIONS for mcq with null config.mcq', async () => {
  const doc = makeAssessmentDoc({ config: {} });
  const deps = { Assessment: { findOne: async () => doc } };
  await assert.rejects(
    () => releaseAssessment(SCOPE, 'a1', 'user1', deps),
    /NO_QUESTIONS/
  );
});

// ---------------------------------------------------------------------------
// releaseAssessment — interview and capstone are unaffected by NO_QUESTIONS gate
// ---------------------------------------------------------------------------

test('releaseAssessment succeeds for interview type (no questions required)', async () => {
  const doc = makeAssessmentDoc({ type: 'interview', config: { interview: {} } });
  const deps = { Assessment: { findOne: async () => doc } };
  const result = await releaseAssessment(SCOPE, 'a1', 'user1', deps);
  assert.strictEqual(result.status, 'released');
});

test('releaseAssessment succeeds for capstone type (no questions required)', async () => {
  const doc = makeAssessmentDoc({ type: 'capstone', config: { capstone: { bundleId: 'existing-bundle' } } });
  const deps = { Assessment: { findOne: async () => doc } };
  const result = await releaseAssessment(SCOPE, 'a1', 'user1', deps);
  assert.strictEqual(result.status, 'released');
});

// ---------------------------------------------------------------------------
// releaseAssessment — NO_BUNDLE gate
// ---------------------------------------------------------------------------

test('releaseAssessment throws NO_BUNDLE for capstone with no bundleId', async () => {
  const doc = makeAssessmentDoc({ type: 'capstone', config: { capstone: {} } });
  const deps = { Assessment: { findOne: async () => doc } };
  await assert.rejects(
    () => releaseAssessment(SCOPE, 'a1', 'user1', deps),
    (err) => {
      assert.strictEqual(err.message, 'NO_BUNDLE');
      return true;
    }
  );
});

test('releaseAssessment succeeds for capstone with bundleId set', async () => {
  const doc = makeAssessmentDoc({ type: 'capstone', config: { capstone: { bundleId: 'b1' } } });
  const deps = { Assessment: { findOne: async () => doc } };
  const result = await releaseAssessment(SCOPE, 'a1', 'user1', deps);
  assert.strictEqual(result.status, 'released');
});

// ---------------------------------------------------------------------------
// releaseAssessment — other error paths unchanged
// ---------------------------------------------------------------------------

test('releaseAssessment throws NOT_FOUND when assessment not found', async () => {
  const deps = { Assessment: { findOne: async () => null } };
  await assert.rejects(() => releaseAssessment(SCOPE, 'missing', 'user1', deps), /NOT_FOUND/);
});

test('releaseAssessment throws BAD_STATUS when assessment is already released', async () => {
  const doc = makeAssessmentDoc({ status: 'released' });
  const deps = { Assessment: { findOne: async () => doc } };
  await assert.rejects(() => releaseAssessment(SCOPE, 'a1', 'user1', deps), /BAD_STATUS/);
});

test('releaseAssessment throws BAD_STATUS when assessment is in draft status', async () => {
  const doc = makeAssessmentDoc({ status: 'draft' });
  const deps = { Assessment: { findOne: async () => doc } };
  await assert.rejects(() => releaseAssessment(SCOPE, 'a1', 'user1', deps), /BAD_STATUS/);
});
