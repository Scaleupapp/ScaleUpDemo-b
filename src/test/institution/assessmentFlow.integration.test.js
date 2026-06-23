'use strict';
/**
 * Service-integration tests for the full assessment loop per engine.
 *
 * No DB, no Redis, no LLM. All services run against a shared in-memory store
 * that mimics just enough of the Mongoose API to satisfy their deps.
 *
 * Engines covered: interview, mcq, capstone
 * Worker coverage: runSyncTick (finalize in_progress, expire window-closed)
 * Race coverage: duplicate-key / single-attempt guard
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createAssessment, releaseAssessment } = require('../../services/institution/assessment/assessmentService');
const { authorMcq, authorCapstone } = require('../../services/institution/assessment/assessmentAuthoringService');
const { startSession, syncSession } = require('../../services/institution/assessment/assessmentSessionService');
const { recompute } = require('../../services/institution/assessment/cohortRollupService');
const { markActive } = require('../../services/institution/enrollmentProgressService');
const { runSyncTick } = require('../../workers/assessmentSync.worker');

// ─── In-memory store ─────────────────────────────────────────────────────────

let _idCounter = 0;
function nextId() { return `id_${++_idCounter}`; }

/**
 * Query-match helper: supports equality, $in, $ne, $nin.
 */
function matchesQuery(doc, query) {
  for (const [key, val] of Object.entries(query)) {
    if (key === '$and') {
      if (!val.every((sub) => matchesQuery(doc, sub))) return false;
      continue;
    }
    const docVal = doc[key];
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      // Operator object
      if ('$in' in val) {
        if (!val.$in.includes(docVal)) return false;
      }
      if ('$ne' in val) {
        if (docVal === val.$ne) return false;
      }
      if ('$nin' in val) {
        if (val.$nin.includes(docVal)) return false;
      }
      if ('$gt' in val) {
        if (!(docVal > val.$gt)) return false;
      }
    } else {
      // Plain equality (handles string/number; also handles ObjectId-like objects)
      const dv = docVal !== null && docVal !== undefined && typeof docVal === 'object' && 'toString' in docVal ? String(docVal) : docVal;
      const qv = val !== null && val !== undefined && typeof val === 'object' && 'toString' in val ? String(val) : val;
      if (String(dv) !== String(qv)) return false;
    }
  }
  return true;
}

/**
 * Create a minimal in-memory Mongoose-ish collection.
 * Returned docs are live objects: mutating them and calling .save() writes back.
 */
function makeCollection(name) {
  const store = new Map();

  function wrap(raw) {
    if (!raw || typeof raw !== 'object') return raw;
    if (raw.__isWrapped) return raw;
    const obj = Object.assign({}, raw);
    obj.__isWrapped = true;
    obj._id = obj._id || nextId();
    obj.markModified = () => {};
    obj.save = async function () {
      const clone = Object.assign({}, this);
      store.set(String(this._id), clone);
      return this;
    };
    return obj;
  }

  return {
    _store: store,
    _name: name,

    async create(data) {
      const doc = wrap({ ...data });
      doc._id = data._id || nextId();
      store.set(String(doc._id), Object.assign({}, doc));
      return doc;
    },

    async findById(id) {
      if (!id) return null;
      const raw = store.get(String(id));
      return raw ? wrap({ ...raw }) : null;
    },

    async findOne(query) {
      for (const raw of store.values()) {
        if (matchesQuery(raw, query)) return wrap({ ...raw });
      }
      return null;
    },

    find(query) {
      const results = [];
      for (const raw of store.values()) {
        if (!query || matchesQuery(raw, query)) results.push(wrap({ ...raw }));
      }
      // Return a thenable object (NOT an array — to avoid the array spreading into a
      // Promise chain that OOMs). Supports .sort().limit() chaining then await.
      const obj = {
        _results: results,
        sort(_fn) { return this; },
        limit(_n) { return this; },
        then(onFulfilled, onRejected) {
          return Promise.resolve(this._results).then(onFulfilled, onRejected);
        },
        [Symbol.iterator]() { return this._results[Symbol.iterator](); },
        filter(...args) { return this._results.filter(...args); },
        map(...args) { return this._results.map(...args); },
        forEach(...args) { return this._results.forEach(...args); },
        get length() { return this._results.length; },
      };
      return obj;
    },

    async updateMany(query, update) {
      let n = 0;
      for (const [key, raw] of store.entries()) {
        if (matchesQuery(raw, query)) {
          const patched = { ...raw };
          if (update.$set) Object.assign(patched, update.$set);
          store.set(key, patched);
          n++;
        }
      }
      return { modifiedCount: n };
    },

    async updateOne(query, update) {
      for (const [key, raw] of store.entries()) {
        if (matchesQuery(raw, query)) {
          const patched = { ...raw };
          if (update.$set) Object.assign(patched, update.$set);
          store.set(key, patched);
          return { modifiedCount: 1 };
        }
      }
      return { modifiedCount: 0 };
    },

    async findByIdAndUpdate(id, update, opts = {}) {
      const raw = store.get(String(id));
      if (!raw) {
        if (opts.upsert) {
          const doc = wrap({ _id: id, ...update.$set });
          store.set(String(doc._id), Object.assign({}, doc));
          return doc;
        }
        return null;
      }
      const patched = { ...raw };
      if (update.$set) Object.assign(patched, update.$set);
      store.set(String(id), patched);
      return opts.new ? wrap({ ...patched }) : wrap({ ...raw });
    },

    async findOneAndUpdate(query, update, opts = {}) {
      for (const [key, raw] of store.entries()) {
        if (matchesQuery(raw, query)) {
          const patched = { ...raw };
          if (update.$set) Object.assign(patched, update.$set);
          store.set(key, patched);
          return opts.new ? wrap({ ...patched }) : wrap({ ...raw });
        }
      }
      // upsert
      if (opts.upsert) {
        const doc = wrap({ ...query, ...(update.$set || {}) });
        store.set(String(doc._id), Object.assign({}, doc));
        return opts.new ? doc : null;
      }
      return null;
    },

    async findByIdAndDelete(id) {
      const raw = store.get(String(id));
      if (raw) store.delete(String(id));
      return raw ? wrap({ ...raw }) : null;
    },

    async deleteOne(query) {
      for (const [key, raw] of store.entries()) {
        if (matchesQuery(raw, query)) {
          store.delete(key);
          return { deletedCount: 1 };
        }
      }
      return { deletedCount: 0 };
    },

    async countDocuments(query) {
      let n = 0;
      for (const raw of store.values()) {
        if (!query || matchesQuery(raw, query)) n++;
      }
      return n;
    },
  };
}

// ─── Shared store factory ─────────────────────────────────────────────────────

function makeStores() {
  return {
    Assessment: makeCollection('Assessment'),
    AssessmentSession: makeCollection('AssessmentSession'),
    CohortRollup: makeCollection('CohortRollup'),
    InstitutionEnrollment: makeCollection('InstitutionEnrollment'),
    InstitutionCohort: makeCollection('InstitutionCohort'),
    Quiz: makeCollection('Quiz'),
    QuizAttempt: makeCollection('QuizAttempt'),
    InterviewSession: makeCollection('InterviewSession'),
    CapstoneSession: makeCollection('CapstoneSession'),
    ArtifactBundle: makeCollection('ArtifactBundle'),
    CapstoneGenerationRequest: makeCollection('CapstoneGenerationRequest'),
  };
}

const PAST = new Date(Date.now() - 86400000);
const FUTURE = new Date(Date.now() + 86400000);
const FIXED_NOW = new Date();

// ─────────────────────────────────────────────────────────────────────────────
// INTERVIEW ENGINE — full lifecycle
// ─────────────────────────────────────────────────────────────────────────────

test('interview engine: full lifecycle (create→release→start→grade→sync→rollup)', async (t) => {
  const S = makeStores();
  const institutionId = 'inst1';
  const cohortId = nextId();
  const scope = { institutionId };

  // Seed cohort
  await S.InstitutionCohort.create({ _id: cohortId, institutionId, name: 'Cohort A' });
  // Seed enrollment
  await S.InstitutionEnrollment.create({ userId: 'stu1', cohortId, institutionId, status: 'registered' });

  // 1. createAssessment
  const a = await createAssessment(scope, {
    cohortId,
    type: 'interview',
    title: 'HR Interview',
    config: { interview: { interviewType: 'placement_hr' } },
    createdBy: 'admin1',
    opensAt: PAST,
    closesAt: FUTURE,
  }, { Assessment: S.Assessment, InstitutionCohort: S.InstitutionCohort });
  assert.equal(a.status, 'configured', 'status should be configured after create');
  const assessmentId = String(a._id);

  // 2. releaseAssessment
  const released = await releaseAssessment(scope, assessmentId, 'admin1', { Assessment: S.Assessment });
  assert.equal(released.status, 'released');

  // 3. startSession — interview engine with stub interviewService
  let interviewStartCallCount = 0;
  const fakeInterviewSessionId = nextId();
  await S.InterviewSession.create({
    _id: fakeInterviewSessionId,
    status: 'in_progress',
    evaluation: null,
  });

  const interviewAdapterDeps = {
    interviewService: {
      startInterview: async (_userId, _opts) => {
        interviewStartCallCount++;
        return { session: { _id: fakeInterviewSessionId } };
      },
    },
    InterviewSession: S.InterviewSession,
  };

  const deps = {
    Assessment: S.Assessment,
    AssessmentSession: S.AssessmentSession,
    InstitutionEnrollment: S.InstitutionEnrollment,
    now: () => FIXED_NOW,
    adapterDeps: interviewAdapterDeps,
    enrollmentProgressService: { markActive },
    cohortRollupService: { recompute },
    CohortRollup: S.CohortRollup,
    InterviewSession: S.InterviewSession,
  };

  const sess = await startSession('stu1', assessmentId, deps);
  assert.equal(sess.status, 'in_progress');
  assert.equal(String(sess.engine.type), 'interview');
  assert.ok(sess.engine.sessionId, 'engine.sessionId should be set');
  assert.equal(interviewStartCallCount, 1, 'adapter.start called exactly once');
  const sessionId = String(sess._id);

  await t.test('startSession is idempotent (single-attempt guard)', async () => {
    // The real service guards on unique index (code 11000). We simulate this:
    // patch AssessmentSession.create to ALWAYS throw 11000 (the "loser" path).
    // The service will then call findOne({ assessmentId, userId }) and return the
    // existing session (id = sessionId, already written to the store above).
    const origCreate = S.AssessmentSession.create.bind(S.AssessmentSession);
    S.AssessmentSession.create = async (_data) => {
      const err = new Error('E11000 duplicate key error');
      err.code = 11000;
      throw err;
    };

    const sess2 = await startSession('stu1', assessmentId, deps);
    assert.equal(String(sess2._id), sessionId, 'should return same session id');
    assert.equal(interviewStartCallCount, 1, 'adapter.start NOT called a second time');

    // Restore
    S.AssessmentSession.create = origCreate;
  });

  // 4. Simulate grading: update the fake InterviewSession
  const rawInterviewSession = S.InterviewSession._store.get(String(fakeInterviewSessionId));
  Object.assign(rawInterviewSession, {
    status: 'evaluated',
    evaluation: {
      overallScore: 72,
      integrityReport: { overallIntegrity: 'clean' },
      communication: { score: 70 },
      content: { score: 74 },
      structure: { score: 71 },
      confidence: { score: 73 },
    },
  });
  S.InterviewSession._store.set(String(fakeInterviewSessionId), rawInterviewSession);

  // 5. syncSession
  const synced = await syncSession(sessionId, {
    ...deps,
    AssessmentSession: S.AssessmentSession,
  });
  assert.equal(synced.status, 'graded');
  assert.equal(synced.result.score, 72);

  // 6. Enrollment should have flipped to 'active'
  const enrollment = await S.InstitutionEnrollment.findOne({ userId: 'stu1', cohortId });
  assert.equal(enrollment.status, 'active', 'enrollment should be active after sync');

  // 7. Rollup should exist with graded count + avgScore + byCompetency
  const rollup = await S.CohortRollup.findOne({ institutionId, cohortId, assessmentId });
  assert.ok(rollup, 'rollup should exist');
  assert.equal(rollup.counts.graded, 1);
  assert.equal(rollup.avgScore, 72);
  const byComp = rollup.byCompetency;
  assert.ok(Array.isArray(byComp) && byComp.length >= 4, 'byCompetency should have 4 interview dimensions');
  const dimNames = byComp.map((c) => c.name);
  assert.ok(dimNames.includes('communication'), 'communication dimension present');
  assert.ok(dimNames.includes('content'), 'content dimension present');
  assert.ok(dimNames.includes('structure'), 'structure dimension present');
  assert.ok(dimNames.includes('confidence'), 'confidence dimension present');

  // 8. syncSession idempotent (2nd call on already-graded session)
  const interviewStartCountBefore = interviewStartCallCount;
  const synced2 = await syncSession(sessionId, {
    ...deps,
    AssessmentSession: S.AssessmentSession,
  });
  assert.equal(synced2.status, 'graded', 'still graded on 2nd sync');
  assert.equal(interviewStartCallCount, interviewStartCountBefore, 'adapter.start not called again');
  // Rollup recompute should NOT re-run on idempotent sync (early return)
  // (verifiable: graded count stays 1)
  const rollup2 = await S.CohortRollup.findOne({ institutionId, cohortId, assessmentId });
  assert.equal(rollup2.counts.graded, 1, 'rollup graded count unchanged');
});

// ─────────────────────────────────────────────────────────────────────────────
// MCQ ENGINE — full lifecycle
// ─────────────────────────────────────────────────────────────────────────────

test('mcq engine: create→release-before-authoring (409 NO_QUESTIONS)→author→release→start→grade→sync→rollup', async () => {
  const S = makeStores();
  const institutionId = 'inst2';
  const cohortId = nextId();
  const scope = { institutionId };

  await S.InstitutionCohort.create({ _id: cohortId, institutionId, name: 'MCQ Cohort' });
  await S.InstitutionEnrollment.create({ userId: 'stu2', cohortId, institutionId, status: 'registered' });

  // 1. createAssessment
  const a = await createAssessment(scope, {
    cohortId,
    type: 'mcq',
    title: 'DSA Test',
    config: { mcq: { totalQuestions: 2 } },
    createdBy: 'admin2',
    opensAt: PAST,
    closesAt: FUTURE,
  }, { Assessment: S.Assessment, InstitutionCohort: S.InstitutionCohort });
  assert.equal(a.status, 'configured');
  const assessmentId = String(a._id);

  // 2. Attempt release BEFORE authoring → should throw NO_QUESTIONS
  await assert.rejects(
    () => releaseAssessment(scope, assessmentId, 'admin2', { Assessment: S.Assessment }),
    (err) => { assert.equal(err.message, 'NO_QUESTIONS'); return true; },
    'release before authoring should throw NO_QUESTIONS'
  );

  // 3. authorMcq — stub quizGenerationService.generateQuiz returns a quiz with 2 questions
  const fakeQuizId = nextId();
  const fakeQuestions = [
    { questionText: 'Q1', options: ['A', 'B'], correct: 'A', competency: 'DSA' },
    { questionText: 'Q2', options: ['C', 'D'], correct: 'C', competency: 'DSA' },
  ];
  const authored = await authorMcq(assessmentId, {
    Assessment: S.Assessment,
    Quiz: S.Quiz,
    quizGenerationService: {
      generateQuiz: async (_opts) => ({
        _id: fakeQuizId,
        questions: fakeQuestions,
      }),
    },
  });
  assert.ok(authored.config.mcq.questions.length === 2, 'questions should be frozen onto assessment');
  // The throwaway quiz should have been deleted
  const deletedQuiz = await S.Quiz.findById(fakeQuizId);
  assert.equal(deletedQuiz, null, 'throwaway quiz deleted after authoring');

  // 4. releaseAssessment AFTER authoring → should succeed
  const released = await releaseAssessment(scope, assessmentId, 'admin2', { Assessment: S.Assessment });
  assert.equal(released.status, 'released');

  // 5. startSession via REAL mcq adapter (injected Quiz + QuizAttempt)
  const mcqAdapterDeps = {
    Quiz: S.Quiz,
    QuizAttempt: S.QuizAttempt,
  };

  const deps = {
    Assessment: S.Assessment,
    AssessmentSession: S.AssessmentSession,
    InstitutionEnrollment: S.InstitutionEnrollment,
    now: () => FIXED_NOW,
    adapterDeps: mcqAdapterDeps,
    enrollmentProgressService: { markActive },
    cohortRollupService: { recompute },
    AssessmentSession_store: S.AssessmentSession,
    CohortRollup: S.CohortRollup,
  };

  const sess = await startSession('stu2', assessmentId, deps);
  assert.equal(sess.status, 'in_progress');
  assert.equal(sess.engine.type, 'mcq');
  assert.ok(sess.engine.quizId, 'engine.quizId should be set');
  assert.ok(sess.engine.sessionId, 'engine.sessionId (attempt _id) should be set');
  const sessionId = String(sess._id);

  // Verify a Quiz clone was created in the store
  const quizClone = await S.Quiz.findById(sess.engine.quizId);
  assert.ok(quizClone, 'Quiz clone exists');
  assert.equal(quizClone.source, 'institution_assessment');
  assert.equal(quizClone.questions.length, 2, 'quiz has 2 questions');

  // Verify a QuizAttempt was created
  const attempt = await S.QuizAttempt.findById(sess.engine.sessionId);
  assert.ok(attempt, 'QuizAttempt exists');
  assert.equal(attempt.status, 'in_progress');

  // 6. Simulate completion: mark attempt completed with score + competencyBreakdown
  const rawAttempt = S.QuizAttempt._store.get(String(sess.engine.sessionId));
  Object.assign(rawAttempt, {
    status: 'completed',
    score: { percentage: 80 },
    competencyBreakdown: [{ competency: 'DSA', percentage: 80 }],
    topicBreakdown: [],
  });
  S.QuizAttempt._store.set(String(rawAttempt._id), rawAttempt);

  // 7. syncSession → graded
  const synced = await syncSession(sessionId, {
    ...deps,
    AssessmentSession: S.AssessmentSession,
  });
  assert.equal(synced.status, 'graded');
  assert.equal(synced.result.score, 80);

  // 8. Enrollment flipped to active
  const enrollment = await S.InstitutionEnrollment.findOne({ userId: 'stu2', cohortId });
  assert.equal(enrollment.status, 'active');

  // 9. Rollup byCompetency has DSA
  const rollup = await S.CohortRollup.findOne({ institutionId, cohortId, assessmentId });
  assert.ok(rollup, 'rollup exists');
  assert.equal(rollup.counts.graded, 1);
  assert.equal(rollup.avgScore, 80);
  const dsaEntry = rollup.byCompetency.find((c) => c.name === 'DSA');
  assert.ok(dsaEntry, 'DSA competency in rollup');
  assert.equal(dsaEntry.avgScore, 80);
});

// ─────────────────────────────────────────────────────────────────────────────
// CAPSTONE ENGINE — full lifecycle
// ─────────────────────────────────────────────────────────────────────────────

test('capstone engine: create→release-before-bundle (409 NO_BUNDLE)→author→release→start→grade→sync→rollup', async () => {
  const S = makeStores();
  const institutionId = 'inst3';
  const cohortId = nextId();
  const scope = { institutionId };

  await S.InstitutionCohort.create({ _id: cohortId, institutionId, name: 'Capstone Cohort' });
  await S.InstitutionEnrollment.create({ userId: 'stu3', cohortId, institutionId, status: 'registered' });

  // 1. createAssessment — capstone requires roleTrack (no bundleId yet)
  const a = await createAssessment(scope, {
    cohortId,
    type: 'capstone',
    title: 'SWE Capstone',
    config: { capstone: { roleTrack: 'swe', difficulty: 'medium' } },
    createdBy: 'admin3',
    opensAt: PAST,
    closesAt: FUTURE,
  }, { Assessment: S.Assessment, InstitutionCohort: S.InstitutionCohort });
  assert.equal(a.status, 'configured');
  const assessmentId = String(a._id);

  // 2. Release BEFORE bundle → NO_BUNDLE
  await assert.rejects(
    () => releaseAssessment(scope, assessmentId, 'admin3', { Assessment: S.Assessment }),
    (err) => { assert.equal(err.message, 'NO_BUNDLE'); return true; },
    'release before bundle should throw NO_BUNDLE'
  );

  // 3. authorCapstone — stub requestGeneration creates a CapstoneGenerationRequest
  //    that is immediately 'ready' after the first poll (using pollMs=0, maxPolls=3)
  const bundleId = nextId();
  const reqId = nextId();

  // Pre-seed ArtifactBundle as active
  await S.ArtifactBundle.create({ _id: bundleId, status: 'active', type: 'capstone' });

  // requestGeneration stub: insert a req doc with status='ready'
  const stubRequestGeneration = async (_opts, _deps) => {
    const req = await S.CapstoneGenerationRequest.create({
      _id: reqId,
      status: 'ready',
      bundle_id: bundleId,
    });
    return req;
  };

  const authored = await authorCapstone(assessmentId, {
    Assessment: S.Assessment,
    ArtifactBundle: S.ArtifactBundle,
    CapstoneGenerationRequest: S.CapstoneGenerationRequest,
    requestGeneration: stubRequestGeneration,
    sleep: async () => {}, // no-op sleep for test speed
    pollMs: 0,
    maxPolls: 3,
  });
  assert.ok(authored, 'authorCapstone returned assessment');
  assert.equal(String(authored.config.capstone.bundleId), String(bundleId), 'bundleId set on config');

  // 4. Release AFTER bundle → success
  const released = await releaseAssessment(scope, assessmentId, 'admin3', { Assessment: S.Assessment });
  assert.equal(released.status, 'released');

  // 5. startSession via capstone adapter with stub startCapstone
  const fakeCapstoneSessionId = nextId();
  await S.CapstoneSession.create({
    _id: fakeCapstoneSessionId,
    status: 'scheduled',
    result: null,
  });

  let capstoneStartCallCount = 0;
  const capstoneAdapterDeps = {
    startCapstone: async ({ userId: _uid, bundleId: _bid }) => {
      capstoneStartCallCount++;
      return { session: { _id: fakeCapstoneSessionId } };
    },
    CapstoneSession: S.CapstoneSession,
    pairingService: {
      mintCode: async () => ({ code: 'TESTCODE', expiresAt: FUTURE }),
    },
  };

  const deps = {
    Assessment: S.Assessment,
    AssessmentSession: S.AssessmentSession,
    InstitutionEnrollment: S.InstitutionEnrollment,
    now: () => FIXED_NOW,
    adapterDeps: capstoneAdapterDeps,
    enrollmentProgressService: { markActive },
    cohortRollupService: { recompute },
    CohortRollup: S.CohortRollup,
    CapstoneSession: S.CapstoneSession,
  };

  const sess = await startSession('stu3', assessmentId, deps);
  assert.equal(sess.status, 'in_progress');
  assert.equal(sess.engine.type, 'capstone');
  assert.equal(String(sess.engine.sessionId), String(fakeCapstoneSessionId));
  assert.equal(capstoneStartCallCount, 1);
  const sessionId = String(sess._id);

  // 6. Simulate grading: update fake CapstoneSession
  const rawCS = S.CapstoneSession._store.get(String(fakeCapstoneSessionId));
  Object.assign(rawCS, {
    status: 'graded',
    result: {
      overall_score: 65,
      integrity_confidence: 'high',
      dimension_scores: {
        correctness: 7,
        code_quality: 6,
        ai_pair_effectiveness: 7,
        verification_discipline: 6,
        decomposition: 6,
        reflection_quality: 7,
      },
    },
  });
  S.CapstoneSession._store.set(String(fakeCapstoneSessionId), rawCS);

  // 7. syncSession → graded
  const synced = await syncSession(sessionId, {
    ...deps,
    AssessmentSession: S.AssessmentSession,
  });
  assert.equal(synced.status, 'graded');
  assert.equal(synced.result.score, 65);
  assert.equal(synced.result.integrity, 'high');

  // 8. Enrollment flipped to active
  const enrollment = await S.InstitutionEnrollment.findOne({ userId: 'stu3', cohortId });
  assert.equal(enrollment.status, 'active');

  // 9. Rollup byCompetency has the 6 capstone dimensions (×10 scaled)
  const rollup = await S.CohortRollup.findOne({ institutionId, cohortId, assessmentId });
  assert.ok(rollup, 'rollup exists');
  assert.equal(rollup.counts.graded, 1);
  assert.equal(rollup.avgScore, 65);
  const byComp = rollup.byCompetency;
  assert.ok(Array.isArray(byComp) && byComp.length === 6, 'byCompetency has 6 capstone dimensions');
  const correctness = byComp.find((c) => c.name === 'correctness');
  assert.ok(correctness, 'correctness dimension present');
  assert.equal(correctness.avgScore, 70, 'correctness 7×10=70');
  const codeQuality = byComp.find((c) => c.name === 'code_quality');
  assert.equal(codeQuality.avgScore, 60, 'code_quality 6×10=60');
});

// ─────────────────────────────────────────────────────────────────────────────
// WORKER — runSyncTick
// ─────────────────────────────────────────────────────────────────────────────

test('worker runSyncTick: finalizes in_progress session whose engine has graded', async () => {
  const S = makeStores();
  const institutionId = 'inst4';
  const cohortId = nextId();

  // Pre-seed a released assessment (still open)
  const assessId = nextId();
  await S.Assessment.create({
    _id: assessId,
    institutionId,
    cohortId,
    type: 'interview',
    status: 'released',
    opensAt: PAST,
    closesAt: FUTURE,
  });

  // Pre-seed enrollment
  await S.InstitutionEnrollment.create({ userId: 'stu4', cohortId, institutionId, status: 'registered' });

  // Pre-seed an in_progress AssessmentSession
  const fakeInterviewSessionId = nextId();
  const sessId = nextId();
  await S.AssessmentSession.create({
    _id: sessId,
    assessmentId: assessId,
    institutionId,
    cohortId,
    userId: 'stu4',
    engine: { type: 'interview', sessionId: fakeInterviewSessionId },
    status: 'in_progress',
    result: null,
  });

  // Seed the InterviewSession as evaluated/graded
  await S.InterviewSession.create({
    _id: fakeInterviewSessionId,
    status: 'evaluated',
    evaluation: {
      overallScore: 85,
      integrityReport: { overallIntegrity: 'clean' },
      communication: { score: 84 },
      content: { score: 86 },
      structure: { score: 85 },
      confidence: { score: 85 },
    },
  });

  // Build a real syncSession bound to these stores
  const adapterDeps = {
    InterviewSession: S.InterviewSession,
  };

  const syncDeps = {
    Assessment: S.Assessment,
    AssessmentSession: S.AssessmentSession,
    InstitutionEnrollment: S.InstitutionEnrollment,
    now: () => FIXED_NOW,
    adapterDeps,
    enrollmentProgressService: { markActive },
    cohortRollupService: { recompute },
    CohortRollup: S.CohortRollup,
  };

  // runSyncTick uses a deps.syncSession function (defaults to real one).
  // We inject a wrapper that passes our deps to the real syncSession.
  await runSyncTick({
    AssessmentSession: S.AssessmentSession,
    Assessment: S.Assessment,
    syncSession: (sid) => syncSession(sid, syncDeps),
    now: () => FIXED_NOW,
  });

  // Session should now be graded
  const finalSess = await S.AssessmentSession.findById(sessId);
  assert.equal(finalSess.status, 'graded', 'worker should finalize graded session');
  assert.equal(finalSess.result.score, 85);

  // Enrollment should be active
  const enrollment = await S.InstitutionEnrollment.findOne({ userId: 'stu4', cohortId });
  assert.equal(enrollment.status, 'active');
});

test('worker runSyncTick: expires session when closesAt has passed and engine not graded', async () => {
  const S = makeStores();
  const institutionId = 'inst5';
  const cohortId = nextId();

  // Assessment with closesAt in the past
  const assessId = nextId();
  await S.Assessment.create({
    _id: assessId,
    institutionId,
    cohortId,
    type: 'mcq',
    status: 'released',
    opensAt: new Date(Date.now() - 172800000), // 2 days ago
    closesAt: PAST, // closed yesterday
  });

  // in_progress session for this assessment
  const sessId = nextId();
  await S.AssessmentSession.create({
    _id: sessId,
    assessmentId: assessId,
    institutionId,
    cohortId,
    userId: 'stu5',
    engine: { type: 'mcq', sessionId: nextId() },
    status: 'in_progress',
    result: null,
  });

  let syncSessionCalled = false;
  await runSyncTick({
    AssessmentSession: S.AssessmentSession,
    Assessment: S.Assessment,
    syncSession: async (_sid) => { syncSessionCalled = true; },
    now: () => FIXED_NOW,
  });

  const expired = await S.AssessmentSession.findById(sessId);
  assert.equal(expired.status, 'expired', 'session should be expired');
  assert.equal(syncSessionCalled, false, 'syncSession should NOT be called for expired session');
});

// ─────────────────────────────────────────────────────────────────────────────
// RACE — single-attempt duplicate-key guard
// ─────────────────────────────────────────────────────────────────────────────

test('race: second concurrent startSession returns existing session without calling adapter.start twice', async () => {
  const S = makeStores();
  const institutionId = 'inst6';
  const cohortId = nextId();
  const scope = { institutionId };

  await S.InstitutionCohort.create({ _id: cohortId, institutionId, name: 'Race Cohort' });
  await S.InstitutionEnrollment.create({ userId: 'stu6', cohortId, institutionId, status: 'registered' });

  const a = await createAssessment(scope, {
    cohortId,
    type: 'interview',
    title: 'Race Test',
    config: { interview: { interviewType: 'placement_hr' } },
    createdBy: 'admin6',
    opensAt: PAST,
    closesAt: FUTURE,
  }, { Assessment: S.Assessment, InstitutionCohort: S.InstitutionCohort });
  await releaseAssessment(scope, String(a._id), 'admin6', { Assessment: S.Assessment });
  const assessmentId = String(a._id);

  const fakeInterviewSessionId = nextId();
  await S.InterviewSession.create({ _id: fakeInterviewSessionId, status: 'in_progress' });

  let adapterStartCount = 0;
  const adapterDeps = {
    interviewService: {
      startInterview: async () => {
        adapterStartCount++;
        return { session: { _id: fakeInterviewSessionId } };
      },
    },
    InterviewSession: S.InterviewSession,
  };

  const baseDeps = {
    Assessment: S.Assessment,
    AssessmentSession: S.AssessmentSession,
    InstitutionEnrollment: S.InstitutionEnrollment,
    now: () => FIXED_NOW,
    adapterDeps,
    enrollmentProgressService: { markActive },
    cohortRollupService: { recompute },
    CohortRollup: S.CohortRollup,
  };

  // First call succeeds normally
  const sess1 = await startSession('stu6', assessmentId, baseDeps);
  assert.equal(adapterStartCount, 1, 'adapter.start called once on first attempt');

  // Patch create to throw 11000 on next call (simulates concurrent request losing the race)
  const origCreate = S.AssessmentSession.create.bind(S.AssessmentSession);
  S.AssessmentSession.create = async () => {
    const err = new Error('E11000 duplicate key');
    err.code = 11000;
    throw err;
  };

  const sess2 = await startSession('stu6', assessmentId, baseDeps);
  assert.equal(adapterStartCount, 1, 'adapter.start NOT called second time');
  assert.equal(String(sess2._id), String(sess1._id), 'same session returned to both callers');

  // Restore
  S.AssessmentSession.create = origCreate;
});
