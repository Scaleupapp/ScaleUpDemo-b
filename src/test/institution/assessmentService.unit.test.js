'use strict';
/**
 * Unit tests for src/services/institution/assessment/assessmentService.js
 *
 * All deps injected — no real DB.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createAssessment, releaseAssessment, listAssessments, getAssessment, closeAssessment } = require('../../services/institution/assessment/assessmentService');

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

// releaseAssessment fires authorAgentClosure.closeOnLifecycle fire-and-forget
// (Plan 3, Task 3) — stub it so release-success tests stay real-DB-free.
const NOOP_AUTHOR_AGENT_CLOSURE = { authorAgentClosure: { closeOnLifecycle: async () => ({ closed: false }) } };

// ---------------------------------------------------------------------------
// createAssessment
// ---------------------------------------------------------------------------

test('createAssessment passes scope + payload to Assessment.create', async () => {
  let created = null;
  const deps = {
    Assessment: {
      create: async (d) => { created = d; return { _id: 'new1', ...d }; },
    },
    InstitutionCohort: {
      findOne: async () => ({ _id: 'c1' }), // cohort exists
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
  const deps = { Assessment: { findOne: async () => doc }, ...NOOP_AUTHOR_AGENT_CLOSURE };
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
  const deps = { Assessment: { findOne: async () => doc }, ...NOOP_AUTHOR_AGENT_CLOSURE };
  const result = await releaseAssessment(SCOPE, 'a1', 'user1', deps);
  assert.strictEqual(result.status, 'released');
});

test('releaseAssessment succeeds for capstone type (no questions required)', async () => {
  const doc = makeAssessmentDoc({ type: 'capstone', config: { capstone: { bundleId: 'existing-bundle' } } });
  const deps = { Assessment: { findOne: async () => doc }, ...NOOP_AUTHOR_AGENT_CLOSURE };
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
  const deps = { Assessment: { findOne: async () => doc }, ...NOOP_AUTHOR_AGENT_CLOSURE };
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

// ---------------------------------------------------------------------------
// closeAssessment (Sub-feature C)
// ---------------------------------------------------------------------------

test('closeAssessment sets status=closed and closedAt', async () => {
  const fakeNow = new Date('2026-06-23T12:00:00Z');
  const doc = makeAssessmentDoc({ status: 'released', closesAt: new Date('2026-06-30T00:00:00Z') });
  const deps = {
    Assessment: { findOne: async () => doc },
    now: () => fakeNow,
  };
  const result = await closeAssessment(SCOPE, 'a1', 'user1', deps);
  assert.strictEqual(result.status, 'closed', 'status should be closed');
  assert.strictEqual(result.closedAt, fakeNow, 'closedAt should be set to now');
});

test('closeAssessment sets closesAt=closedAt when closesAt was unset', async () => {
  const fakeNow = new Date('2026-06-23T12:00:00Z');
  const doc = makeAssessmentDoc({ status: 'released', closesAt: undefined });
  const deps = {
    Assessment: { findOne: async () => doc },
    now: () => fakeNow,
  };
  const result = await closeAssessment(SCOPE, 'a1', 'user1', deps);
  assert.strictEqual(result.status, 'closed');
  assert.strictEqual(result.closedAt, fakeNow);
  assert.strictEqual(result.closesAt, fakeNow, 'closesAt should be set to now when it was unset');
});

test('closeAssessment does NOT override existing closesAt', async () => {
  const existingClosesAt = new Date('2026-06-30T00:00:00Z');
  const fakeNow = new Date('2026-06-23T12:00:00Z');
  const doc = makeAssessmentDoc({ status: 'released', closesAt: existingClosesAt });
  const deps = {
    Assessment: { findOne: async () => doc },
    now: () => fakeNow,
  };
  const result = await closeAssessment(SCOPE, 'a1', 'user1', deps);
  assert.strictEqual(result.closesAt, existingClosesAt, 'closesAt should NOT be overridden');
});

test('closeAssessment throws NOT_FOUND when assessment not found', async () => {
  const deps = { Assessment: { findOne: async () => null } };
  await assert.rejects(
    () => closeAssessment(SCOPE, 'missing', 'user1', deps),
    /NOT_FOUND/
  );
});

// ---------------------------------------------------------------------------
// createAssessment — validation (Sub-feature E)
// ---------------------------------------------------------------------------

test('createAssessment throws COHORT_NOT_FOUND when cohort is not in scope', async () => {
  const deps = {
    Assessment: { create: async () => ({}) },
    InstitutionCohort: { findOne: async () => null }, // cohort not found
  };
  await assert.rejects(
    () => createAssessment(SCOPE, { cohortId: 'c-missing', type: 'mcq', title: 'T' }, deps),
    /COHORT_NOT_FOUND/
  );
});

test('createAssessment throws BAD_CONFIG for interview without interviewType', async () => {
  const deps = {
    Assessment: { create: async () => ({}) },
    InstitutionCohort: { findOne: async () => ({ _id: 'c1' }) },
  };
  await assert.rejects(
    () => createAssessment(SCOPE, { cohortId: 'c1', type: 'interview', title: 'T', config: { interview: {} } }, deps),
    /BAD_CONFIG/
  );
});

test('createAssessment throws BAD_CONFIG for capstone without any of bundleId/roleTrack/jobDescription', async () => {
  const deps = {
    Assessment: { create: async () => ({}) },
    InstitutionCohort: { findOne: async () => ({ _id: 'c1' }) },
  };
  await assert.rejects(
    () => createAssessment(SCOPE, { cohortId: 'c1', type: 'capstone', title: 'T', config: { capstone: {} } }, deps),
    /BAD_CONFIG/
  );
});

test('createAssessment succeeds for capstone with only roleTrack (valid enum)', async () => {
  let created = null;
  const deps = {
    Assessment: { create: async (d) => { created = d; return { _id: 'cap1', ...d }; } },
    InstitutionCohort: { findOne: async () => ({ _id: 'c1' }) },
  };
  const result = await createAssessment(SCOPE, {
    cohortId: 'c1', type: 'capstone', title: 'Capstone T',
    config: { capstone: { roleTrack: 'swe' } },
  }, deps);
  assert.strictEqual(result._id, 'cap1');
  assert.ok(created, 'Assessment.create should be called');
});

test('createAssessment throws BAD_CONFIG for capstone with invalid roleTrack', async () => {
  const deps = {
    Assessment: { create: async () => ({}) },
    InstitutionCohort: { findOne: async () => ({ _id: 'c1' }) },
  };
  await assert.rejects(
    () => createAssessment(SCOPE, {
      cohortId: 'c1', type: 'capstone', title: 'Capstone T',
      config: { capstone: { roleTrack: 'software_engineer' } },
    }, deps),
    /BAD_CONFIG/
  );
});

test('createAssessment throws BAD_WINDOW when opensAt >= closesAt (same date)', async () => {
  const deps = {
    Assessment: { create: async () => ({}) },
    InstitutionCohort: { findOne: async () => ({ _id: 'c1' }) },
  };
  const sameDate = new Date('2026-06-25T10:00:00Z').toISOString();
  await assert.rejects(
    () => createAssessment(SCOPE, { cohortId: 'c1', type: 'mcq', title: 'T', opensAt: sameDate, closesAt: sameDate }, deps),
    /BAD_WINDOW/
  );
});

test('createAssessment passes through when opensAt < closesAt', async () => {
  let created = null;
  const deps = {
    Assessment: { create: async (d) => { created = d; return { _id: 'ok1', ...d }; } },
    InstitutionCohort: { findOne: async () => ({ _id: 'c1' }) },
  };
  const result = await createAssessment(SCOPE, {
    cohortId: 'c1', type: 'mcq', title: 'T',
    opensAt: '2026-06-25T08:00:00Z',
    closesAt: '2026-06-25T10:00:00Z',
  }, deps);
  assert.strictEqual(result._id, 'ok1');
  assert.ok(created);
});

// ---------------------------------------------------------------------------
// createAssessment — drill type validation
// ---------------------------------------------------------------------------

test('createAssessment throws BAD_CONFIG for drill without drillSubtype', async () => {
  const deps = {
    Assessment: { create: async () => ({}) },
    InstitutionCohort: { findOne: async () => ({ _id: 'c1' }) },
  };
  await assert.rejects(
    () => createAssessment(SCOPE, {
      cohortId: 'c1', type: 'drill', title: 'Drill T',
      config: { drill: { roleTrack: 'swe' } }, // missing drillSubtype
    }, deps),
    /BAD_CONFIG/
  );
});

test('createAssessment throws BAD_CONFIG for drill with invalid drillSubtype', async () => {
  const deps = {
    Assessment: { create: async () => ({}) },
    InstitutionCohort: { findOne: async () => ({ _id: 'c1' }) },
  };
  await assert.rejects(
    () => createAssessment(SCOPE, {
      cohortId: 'c1', type: 'drill', title: 'Drill T',
      config: { drill: { drillSubtype: 'essay' } }, // invalid
    }, deps),
    /BAD_CONFIG/
  );
});

test('createAssessment throws BAD_CONFIG for drill with invalid roleTrack', async () => {
  const deps = {
    Assessment: { create: async () => ({}) },
    InstitutionCohort: { findOne: async () => ({ _id: 'c1' }) },
  };
  await assert.rejects(
    () => createAssessment(SCOPE, {
      cohortId: 'c1', type: 'drill', title: 'Drill T',
      config: { drill: { drillSubtype: 'prompt', roleTrack: 'backend_engineer' } },
    }, deps),
    /BAD_CONFIG/
  );
});

test('createAssessment succeeds for drill with valid drillSubtype (no roleTrack)', async () => {
  let created = null;
  const deps = {
    Assessment: { create: async (d) => { created = d; return { _id: 'dr1', ...d }; } },
    InstitutionCohort: { findOne: async () => ({ _id: 'c1' }) },
  };
  const result = await createAssessment(SCOPE, {
    cohortId: 'c1', type: 'drill', title: 'Prompt Drill',
    config: { drill: { drillSubtype: 'prompt' } },
  }, deps);
  assert.strictEqual(result._id, 'dr1');
  assert.ok(created);
});

test('createAssessment succeeds for drill with valid drillSubtype + valid roleTrack', async () => {
  let created = null;
  const deps = {
    Assessment: { create: async (d) => { created = d; return { _id: 'dr2', ...d }; } },
    InstitutionCohort: { findOne: async () => ({ _id: 'c1' }) },
  };
  const result = await createAssessment(SCOPE, {
    cohortId: 'c1', type: 'drill', title: 'DS Drill',
    config: { drill: { drillSubtype: 'verify', roleTrack: 'ds' } },
  }, deps);
  assert.strictEqual(result._id, 'dr2');
  assert.ok(created);
});

// ---------------------------------------------------------------------------
// releaseAssessment — drill NO_BUNDLE gate
// ---------------------------------------------------------------------------

test('releaseAssessment throws NO_BUNDLE for drill with no bundleId', async () => {
  const doc = makeAssessmentDoc({ type: 'drill', config: { drill: { drillSubtype: 'prompt' } } });
  const deps = { Assessment: { findOne: async () => doc } };
  await assert.rejects(
    () => releaseAssessment(SCOPE, 'a1', 'user1', deps),
    (err) => { assert.strictEqual(err.message, 'NO_BUNDLE'); return true; }
  );
});

test('releaseAssessment succeeds for drill with bundleId set', async () => {
  const doc = makeAssessmentDoc({ type: 'drill', config: { drill: { bundleId: 'b1', drillSubtype: 'prompt' } } });
  const deps = { Assessment: { findOne: async () => doc }, ...NOOP_AUTHOR_AGENT_CLOSURE };
  const result = await releaseAssessment(SCOPE, 'a1', 'user1', deps);
  assert.strictEqual(result.status, 'released');
});
