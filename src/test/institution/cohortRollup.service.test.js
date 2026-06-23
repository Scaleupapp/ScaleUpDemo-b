'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { recompute } = require('../../services/institution/assessment/cohortRollupService');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(status, score, integrity) {
  return {
    status,
    result: score !== undefined ? { score, integrity: integrity || null } : null,
  };
}

// ---------------------------------------------------------------------------
// recompute tests
// ---------------------------------------------------------------------------

test('recompute computes correct counts and avgScore from sessions', async () => {
  // 3 sessions: 1 scheduled, 1 in_progress, 2 graded (submitted treated as submitted status)
  const sessions = [
    makeSession('scheduled', undefined, undefined),
    makeSession('in_progress', undefined, undefined),
    makeSession('graded', 80, 'high'),
    makeSession('graded', 60, 'high'),
  ];

  let upsertFilter = null;
  let upsertDoc = null;

  const deps = {
    AssessmentSession: {
      find: async () => sessions,
    },
    CohortRollup: {
      findOneAndUpdate: async (filter, update, opts) => {
        upsertFilter = filter;
        upsertDoc = update.$set;
        return { ...update.$set };
      },
    },
    now: () => new Date('2026-06-23T00:00:00Z'),
  };

  const doc = await recompute('inst1', 'cohort1', 'assess1', deps);

  // counts
  assert.strictEqual(doc.counts.assigned, 4, 'assigned = total sessions');
  assert.strictEqual(doc.counts.started, 3, 'started = non-scheduled sessions');
  assert.strictEqual(doc.counts.submitted, 2, 'submitted = graded sessions');
  assert.strictEqual(doc.counts.graded, 2, 'graded = graded sessions');

  // avgScore: (80 + 60) / 2 = 70
  assert.strictEqual(doc.avgScore, 70, 'avgScore should be 70');

  // integrity flags — both are 'high' = 0 flags
  assert.strictEqual(doc.integrityFlags, 0, 'no integrity flags for clean sessions');
});

test('recompute counts integrity flags correctly', async () => {
  const sessions = [
    makeSession('graded', 55, 'suspicious'),
    makeSession('graded', 70, 'high'),
    makeSession('graded', 60, 'minor_flags'),
    makeSession('graded', 80, 'clean'),
  ];

  const deps = {
    AssessmentSession: { find: async () => sessions },
    CohortRollup: { findOneAndUpdate: async () => ({}) },
    now: () => new Date(),
  };

  const doc = await recompute('inst1', 'cohort1', 'assess1', deps);
  // 'suspicious' + 'minor_flags' → 2 flags; 'high' and 'clean' are fine
  assert.strictEqual(doc.integrityFlags, 2);
});

test('recompute calls findOneAndUpdate with correct upsert filter', async () => {
  let capturedFilter = null;
  const deps = {
    AssessmentSession: { find: async () => [] },
    CohortRollup: {
      findOneAndUpdate: async (filter, update, opts) => {
        capturedFilter = filter;
        return {};
      },
    },
    now: () => new Date(),
  };

  await recompute('inst1', 'cohort1', 'assess1', deps);
  assert.deepStrictEqual(capturedFilter, { institutionId: 'inst1', cohortId: 'cohort1', assessmentId: 'assess1' });
});

test('recompute returns undefined avgScore when no graded sessions', async () => {
  const sessions = [
    makeSession('scheduled', undefined, undefined),
    makeSession('in_progress', undefined, undefined),
  ];
  const deps = {
    AssessmentSession: { find: async () => sessions },
    CohortRollup: { findOneAndUpdate: async () => ({}) },
    now: () => new Date(),
  };
  const doc = await recompute('inst1', 'cohort1', 'assess1', deps);
  assert.strictEqual(doc.avgScore, undefined, 'no avgScore when no graded sessions');
  assert.strictEqual(doc.counts.graded, 0);
});
