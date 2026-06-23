'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { startSession, syncSession } = require('../../services/institution/assessment/assessmentSessionService');

// ---------------------------------------------------------------------------
// Helpers — minimal in-memory stubs for the Assessment + AssessmentSession +
// InstitutionEnrollment models.  All deps-injected; no DB/LLM/Redis.
// ---------------------------------------------------------------------------

function makeAssessment(overrides = {}) {
  return {
    _id: 'assess1',
    type: 'mcq',
    status: 'released',
    institutionId: 'inst1',
    cohortId: 'cohort1',
    opensAt: new Date(Date.now() - 60000),  // opened 1 min ago
    closesAt: new Date(Date.now() + 86400000), // closes tomorrow
    config: { mcq: { questions: [{ questionText: 'q1' }], totalQuestions: 1 } },
    ...overrides,
  };
}

function makeEnrollment() {
  return { _id: 'enroll1', userId: 'user1', cohortId: 'cohort1' };
}

function makeSession(overrides = {}) {
  return {
    _id: 'sess1',
    assessmentId: 'assess1',
    institutionId: 'inst1',
    cohortId: 'cohort1',
    userId: 'user1',
    engine: { type: 'capstone', sessionId: 'capSess1' },
    status: 'in_progress',
    result: null,
    save: async function () { return this; },
    ...overrides,
  };
}

// MCQ adapterDeps: Quiz + QuizAttempt stubs so the real mcq adapter works.
function mcqAdapterDeps() {
  return {
    Quiz: {
      create: async (d) => ({ _id: 'quiz1', ...d }),
    },
    QuizAttempt: {
      create: async (d) => ({ _id: 'att1', ...d }),
    },
  };
}

// ---------------------------------------------------------------------------
// startSession tests
// ---------------------------------------------------------------------------

test('startSession happy path: released in-window enrolled → creates session in_progress', async () => {
  const assessment = makeAssessment();
  let created = null;
  let deleteCalled = false;

  // New reserve-first flow: create is called with status='scheduled', then
  // the adapter runs, then the row is updated to in_progress via session.save().
  const mockSession = {
    _id: 'newSess',
    engine: { type: 'mcq' },
    status: 'scheduled',
    save: async function () { this.status = this.status; return this; },
  };

  const deps = {
    Assessment: { findById: async () => assessment },
    AssessmentSession: {
      create: async (d) => { created = d; return { ...mockSession, ...d, save: mockSession.save }; },
      deleteOne: async () => { deleteCalled = true; },
    },
    InstitutionEnrollment: { findOne: async () => makeEnrollment() },
    adapterDeps: mcqAdapterDeps(),
    now: () => new Date(),
  };

  const result = await startSession('user1', 'assess1', deps);
  assert.ok(created, 'session was created');
  assert.strictEqual(created.userId, 'user1');
  assert.strictEqual(created.assessmentId, 'assess1');
  // The reserved row is created with engine.type set; adapter fills sessionId.
  assert.strictEqual(created.engine.type, 'mcq');
  // After adapter.start succeeds, status is flipped to in_progress.
  assert.strictEqual(result.status, 'in_progress');
  assert.strictEqual(deleteCalled, false, 'row was NOT deleted (adapter succeeded)');
});

test('startSession throws NOT_RELEASED when assessment status is draft', async () => {
  const assessment = makeAssessment({ status: 'draft' });
  const deps = {
    Assessment: { findById: async () => assessment },
    AssessmentSession: { findOne: async () => null, create: async () => {} },
    InstitutionEnrollment: { findOne: async () => makeEnrollment() },
    adapterDeps: mcqAdapterDeps(),
    now: () => new Date(),
  };
  await assert.rejects(() => startSession('user1', 'assess1', deps), /NOT_RELEASED/);
});

test('startSession throws NOT_OPEN when now is before opensAt', async () => {
  const futureOpen = new Date(Date.now() + 9999999);
  const assessment = makeAssessment({ opensAt: futureOpen });
  const deps = {
    Assessment: { findById: async () => assessment },
    AssessmentSession: { findOne: async () => null, create: async () => {} },
    InstitutionEnrollment: { findOne: async () => makeEnrollment() },
    adapterDeps: mcqAdapterDeps(),
    now: () => new Date(), // now is before opensAt
  };
  await assert.rejects(() => startSession('user1', 'assess1', deps), /NOT_OPEN/);
});

test('startSession throws CLOSED when now is after closesAt', async () => {
  const pastClose = new Date(Date.now() - 1000);
  const assessment = makeAssessment({ closesAt: pastClose });
  const deps = {
    Assessment: { findById: async () => assessment },
    AssessmentSession: { findOne: async () => null, create: async () => {} },
    InstitutionEnrollment: { findOne: async () => makeEnrollment() },
    adapterDeps: mcqAdapterDeps(),
    now: () => new Date(),
  };
  await assert.rejects(() => startSession('user1', 'assess1', deps), /CLOSED/);
});

test('startSession throws NOT_ENROLLED when no enrollment found', async () => {
  const assessment = makeAssessment();
  const deps = {
    Assessment: { findById: async () => assessment },
    AssessmentSession: { findOne: async () => null, create: async () => {} },
    InstitutionEnrollment: { findOne: async () => null }, // not enrolled
    adapterDeps: mcqAdapterDeps(),
    now: () => new Date(),
  };
  await assert.rejects(() => startSession('user1', 'assess1', deps), /NOT_ENROLLED/);
});

test('startSession returns existing session without calling adapter again (single-attempt / dup-key path)', async () => {
  const assessment = makeAssessment();
  const existing = makeSession();
  let adapterStartCalled = false;
  const adapterDeps = {
    Quiz: { create: async () => { adapterStartCalled = true; return { _id: 'q1' }; } },
    QuizAttempt: { create: async () => ({ _id: 'att1' }) },
  };
  const deps = {
    Assessment: { findById: async () => assessment },
    AssessmentSession: {
      // Simulate the loser: create throws a duplicate-key error.
      create: async () => { const e = new Error('dup'); e.code = 11000; throw e; },
      // findOne is called ONLY on the dup-key path — returns the winner's row.
      findOne: async () => existing,
    },
    InstitutionEnrollment: { findOne: async () => makeEnrollment() },
    adapterDeps,
    now: () => new Date(),
  };
  const result = await startSession('user1', 'assess1', deps);
  assert.strictEqual(result._id, 'sess1', 'returned the existing session');
  assert.strictEqual(adapterStartCalled, false, 'adapter.start was NOT called for the loser');
});

test('startSession: adapter.start failure rolls back reserved row and rethrows', async () => {
  const assessment = makeAssessment();
  let deleteOneCalled = false;
  const mockSession = {
    _id: 'newSess2',
    engine: { type: 'mcq' },
    status: 'scheduled',
    save: async function () { return this; },
  };
  const deps = {
    Assessment: { findById: async () => assessment },
    AssessmentSession: {
      create: async (d) => ({ ...mockSession, ...d, save: mockSession.save }),
      deleteOne: async (filter) => { deleteOneCalled = true; },
    },
    InstitutionEnrollment: { findOne: async () => makeEnrollment() },
    // Inject a broken adapter via adapterDeps — override Quiz.create to throw.
    adapterDeps: {
      Quiz: { create: async () => { throw new Error('ADAPTER_FAIL'); } },
      QuizAttempt: { create: async () => ({ _id: 'att1' }) },
    },
    now: () => new Date(),
  };
  await assert.rejects(() => startSession('user1', 'assess1', deps), /ADAPTER_FAIL/);
  assert.strictEqual(deleteOneCalled, true, 'reserved row was deleted on adapter failure');
});

// ---------------------------------------------------------------------------
// syncSession tests
// ---------------------------------------------------------------------------

test('syncSession: pending engine (done=false) → session stays in_progress, markActive NOT called', async () => {
  let markActiveCalled = false;
  let rollupCalled = false;

  const session = makeSession({ status: 'in_progress' });
  // capstone type with not-yet-graded CapstoneSession
  const deps = {
    AssessmentSession: { findById: async () => session },
    adapterDeps: {
      CapstoneSession: { findById: async () => ({ status: 'in_progress', result: null }) },
    },
    enrollmentProgressService: { markActive: async () => { markActiveCalled = true; } },
    cohortRollupService: { recompute: async () => { rollupCalled = true; } },
    now: () => new Date(),
  };

  const result = await syncSession('sess1', deps);
  assert.strictEqual(result.status, 'in_progress');
  assert.strictEqual(markActiveCalled, false, 'markActive should NOT be called while pending');
  assert.strictEqual(rollupCalled, false, 'rollup recompute should NOT be called while pending');
});

test('syncSession: graded engine (done=true) → status=graded, markActive called with cohortId, rollup called', async () => {
  let markActiveArgs = null;
  let rollupCalled = false;

  const session = makeSession({ status: 'in_progress' });
  // capstone type returning a graded result
  const deps = {
    AssessmentSession: { findById: async () => session },
    adapterDeps: {
      CapstoneSession: {
        findById: async () => ({
          status: 'graded',
          result: { overall_score: 85, integrity_confidence: 'high', dimension_scores: {} },
        }),
      },
    },
    enrollmentProgressService: { markActive: async (uid, cid, d) => { markActiveArgs = { uid, cid }; } },
    cohortRollupService: { recompute: async () => { rollupCalled = true; } },
    now: () => new Date(),
  };

  const result = await syncSession('sess1', deps);
  assert.strictEqual(result.status, 'graded');
  assert.strictEqual(result.result.score, 85);
  assert.strictEqual(result.result.integrity, 'high');
  assert.ok(markActiveArgs, 'markActive MUST be called on grade');
  assert.strictEqual(markActiveArgs.uid, 'user1', 'markActive called with correct userId');
  assert.strictEqual(markActiveArgs.cid, 'cohort1', 'markActive called with cohortId');
  assert.strictEqual(rollupCalled, true, 'rollup recompute MUST be called on grade');
});

test('syncSession: already graded → idempotent no-op (markActive NOT called again)', async () => {
  let markActiveCalled = false;
  let rollupCalled = false;

  const session = makeSession({ status: 'graded', result: { score: 70, integrity: 'medium' } });
  const deps = {
    AssessmentSession: { findById: async () => session },
    adapterDeps: {
      CapstoneSession: { findById: async () => ({ status: 'graded', result: { overall_score: 70 } }) },
    },
    enrollmentProgressService: { markActive: async () => { markActiveCalled = true; } },
    cohortRollupService: { recompute: async () => { rollupCalled = true; } },
    now: () => new Date(),
  };

  const result = await syncSession('sess1', deps);
  assert.strictEqual(result.status, 'graded', 'session remains graded');
  assert.strictEqual(markActiveCalled, false, 'markActive NOT called on idempotent sync');
  assert.strictEqual(rollupCalled, false, 'rollup NOT called on idempotent sync');
});
