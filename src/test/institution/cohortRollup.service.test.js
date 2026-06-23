'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { recompute } = require('../../services/institution/assessment/cohortRollupService');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(status, score, integrity, engineType, raw) {
  const session = {
    status,
    result: score !== undefined ? { score, integrity: integrity || null } : null,
  };
  if (engineType) {
    session.engine = { type: engineType };
  }
  if (raw && session.result) {
    session.result.raw = raw;
  }
  return session;
}

// Default enrollment stub (returns 4 to match old session-count default)
function makeEnrollmentStub(count) {
  return { countDocuments: async () => count };
}

// ---------------------------------------------------------------------------
// recompute tests (existing — updated to inject InstitutionEnrollment)
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
    InstitutionEnrollment: makeEnrollmentStub(4),
    now: () => new Date('2026-06-23T00:00:00Z'),
  };

  const doc = await recompute('inst1', 'cohort1', 'assess1', deps);

  // counts — assigned now comes from enrollment stub (4)
  assert.strictEqual(doc.counts.assigned, 4, 'assigned = enrollment count');
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
    InstitutionEnrollment: makeEnrollmentStub(4),
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
    InstitutionEnrollment: makeEnrollmentStub(0),
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
    InstitutionEnrollment: makeEnrollmentStub(5),
    now: () => new Date(),
  };
  const doc = await recompute('inst1', 'cohort1', 'assess1', deps);
  assert.strictEqual(doc.avgScore, undefined, 'no avgScore when no graded sessions');
  assert.strictEqual(doc.counts.graded, 0);
});

// ---------------------------------------------------------------------------
// Sub-feature A: assigned comes from InstitutionEnrollment.countDocuments
// ---------------------------------------------------------------------------

test('recompute assigned comes from InstitutionEnrollment.countDocuments (not session count)', async () => {
  const sessions = [
    makeSession('graded', 80, 'high'),
    makeSession('graded', 70, 'high'),
    makeSession('in_progress', undefined, undefined),
    makeSession('scheduled', undefined, undefined),
  ]; // 4 sessions

  let countDocumentsFilter = null;
  const deps = {
    AssessmentSession: { find: async () => sessions },
    CohortRollup: { findOneAndUpdate: async () => ({}) },
    InstitutionEnrollment: {
      countDocuments: async (filter) => {
        countDocumentsFilter = filter;
        return 30; // enrollment count is different from session count
      },
    },
    now: () => new Date(),
  };

  const doc = await recompute('inst1', 'cohort1', 'assess1', deps);

  // assigned must be 30 (from enrollment), NOT 4 (session count)
  assert.strictEqual(doc.counts.assigned, 30, 'assigned should come from enrollment count');
  assert.ok(countDocumentsFilter, 'countDocuments should be called');
  assert.strictEqual(countDocumentsFilter.cohortId, 'cohort1');
  assert.deepStrictEqual(countDocumentsFilter.status, { $ne: 'withdrawn' });
});

// ---------------------------------------------------------------------------
// Sub-feature B: byCompetency populated
// ---------------------------------------------------------------------------

test('recompute byCompetency averages correctly for mcq engine', async () => {
  const sessions = [
    makeSession('graded', 80, 'high', 'mcq', {
      competencyBreakdown: [
        { competency: 'data_analysis', percentage: 80 },
        { competency: 'communication', percentage: 70 },
      ],
    }),
    makeSession('graded', 60, 'high', 'mcq', {
      competencyBreakdown: [
        { competency: 'data_analysis', percentage: 60 },
        { competency: 'communication', percentage: 90 },
      ],
    }),
  ];

  const deps = {
    AssessmentSession: { find: async () => sessions },
    CohortRollup: { findOneAndUpdate: async () => ({}) },
    InstitutionEnrollment: makeEnrollmentStub(2),
    now: () => new Date(),
  };

  const doc = await recompute('inst1', 'cohort1', 'assess1', deps);

  assert.ok(Array.isArray(doc.byCompetency), 'byCompetency should be an array');
  assert.strictEqual(doc.byCompetency.length, 2);

  const dataEntry = doc.byCompetency.find((e) => e.name === 'data_analysis');
  assert.ok(dataEntry, 'data_analysis entry should exist');
  assert.strictEqual(dataEntry.avgScore, 70, 'data_analysis avg = (80+60)/2 = 70');
  assert.strictEqual(dataEntry.n, 2);

  const commEntry = doc.byCompetency.find((e) => e.name === 'communication');
  assert.ok(commEntry, 'communication entry should exist');
  assert.strictEqual(commEntry.avgScore, 80, 'communication avg = (70+90)/2 = 80');
  assert.strictEqual(commEntry.n, 2);
});

test('recompute byCompetency averages correctly for interview engine', async () => {
  const sessions = [
    makeSession('graded', 75, 'high', 'interview', {
      dimensions: {
        communication: { score: 80 },
        content: { score: 70 },
      },
    }),
    makeSession('graded', 65, 'high', 'interview', {
      dimensions: {
        communication: { score: 60 },
        content: { score: 90 },
      },
    }),
  ];

  const deps = {
    AssessmentSession: { find: async () => sessions },
    CohortRollup: { findOneAndUpdate: async () => ({}) },
    InstitutionEnrollment: makeEnrollmentStub(2),
    now: () => new Date(),
  };

  const doc = await recompute('inst1', 'cohort1', 'assess1', deps);

  assert.ok(Array.isArray(doc.byCompetency));
  const comm = doc.byCompetency.find((e) => e.name === 'communication');
  assert.ok(comm);
  assert.strictEqual(comm.avgScore, 70, 'communication avg = (80+60)/2 = 70');
  assert.strictEqual(comm.n, 2);

  const content = doc.byCompetency.find((e) => e.name === 'content');
  assert.ok(content);
  assert.strictEqual(content.avgScore, 80, 'content avg = (70+90)/2 = 80');
  assert.strictEqual(content.n, 2);
});

test('recompute byCompetency averages correctly for capstone engine', async () => {
  const sessions = [
    makeSession('graded', 75, 'high', 'capstone', {
      dimension_scores: { problem_solving: 8, communication: 6 },
    }),
    makeSession('graded', 65, 'high', 'capstone', {
      dimension_scores: { problem_solving: 6, communication: 10 },
    }),
  ];

  const deps = {
    AssessmentSession: { find: async () => sessions },
    CohortRollup: { findOneAndUpdate: async () => ({}) },
    InstitutionEnrollment: makeEnrollmentStub(2),
    now: () => new Date(),
  };

  const doc = await recompute('inst1', 'cohort1', 'assess1', deps);

  assert.ok(Array.isArray(doc.byCompetency));
  const ps = doc.byCompetency.find((e) => e.name === 'problem_solving');
  assert.ok(ps);
  // (8*10 + 6*10) / 2 = (80 + 60) / 2 = 70
  assert.strictEqual(ps.avgScore, 70, 'problem_solving avg should be 70 (scaled ×10)');
  assert.strictEqual(ps.n, 2);

  const comm = doc.byCompetency.find((e) => e.name === 'communication');
  assert.ok(comm);
  // (6*10 + 10*10) / 2 = (60 + 100) / 2 = 80
  assert.strictEqual(comm.avgScore, 80, 'communication avg should be 80 (scaled ×10)');
  assert.strictEqual(comm.n, 2);
});

test('recompute byCompetency skips sessions with missing raw', async () => {
  const sessions = [
    // session with raw
    makeSession('graded', 80, 'high', 'mcq', {
      competencyBreakdown: [{ competency: 'logic', percentage: 75 }],
    }),
    // session without raw — makeSession with raw=null
    { status: 'graded', engine: { type: 'mcq' }, result: { score: 60, integrity: 'high', raw: null } },
    // session with no result at all
    { status: 'graded', engine: { type: 'mcq' }, result: null },
  ];

  const deps = {
    AssessmentSession: { find: async () => sessions },
    CohortRollup: { findOneAndUpdate: async () => ({}) },
    InstitutionEnrollment: makeEnrollmentStub(3),
    now: () => new Date(),
  };

  let threw = false;
  let doc;
  try {
    doc = await recompute('inst1', 'cohort1', 'assess1', deps);
  } catch (e) {
    threw = true;
  }

  assert.strictEqual(threw, false, 'recompute should not throw when some sessions have missing raw');
  assert.ok(Array.isArray(doc.byCompetency));
  // Only 1 valid entry from the first session
  assert.strictEqual(doc.byCompetency.length, 1);
  assert.strictEqual(doc.byCompetency[0].name, 'logic');
  assert.strictEqual(doc.byCompetency[0].avgScore, 75);
  assert.strictEqual(doc.byCompetency[0].n, 1);
});
