'use strict';
/**
 * Tests for src/services/institution/assessment/assessmentAuthoringService.js
 *
 * All deps injected — no real DB, no LLM calls.
 */
const test = require('node:test');
const assert = require('node:assert');
const { authorMcq, authorCapstone, authorDrill } = require('../../services/institution/assessment/assessmentAuthoringService');
const { createAssessment } = require('../../services/institution/assessment/assessmentService');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAssessment(overrides = {}) {
  const base = {
    _id: 'assess1',
    type: 'mcq',
    title: 'JavaScript Fundamentals',
    createdBy: 'user1',
    config: {
      mcq: {
        topic: 'JavaScript',
        totalQuestions: 10,
        assessmentType: 'mixed',
        questions: [],
      },
    },
    // Simulate Mongoose markModified + save
    markModified: function () {},
    save: async function () { return this; },
  };
  return { ...base, ...overrides };
}

function makeQuiz(overrides = {}) {
  return {
    _id: 'q1',
    questions: [{ questionText: 'a' }, { questionText: 'b' }],
    ...overrides,
  };
}

// A quiz with N distinct questions (for over-generation / pool assertions).
function makeQuizN(n) {
  return { _id: 'q1', questions: Array.from({ length: n }, (_, i) => ({ questionText: `q${i}` })) };
}

// QA stub that passes every question through all gates and attaches a `qa` object.
function passThroughQa() {
  return {
    runQa: async (questions, ctx = {}) => ({
      passed: questions.map((q) => ({
        ...q,
        qa: {
          lint: { passed: true, failures: [] },
          solver: { agrees: true, confidence: 0.9, ambiguous: false, valid: true },
          judge: { verdict: 'accept', scores: { clarity: 5 }, valid: true },
          generation: ctx.round,
        },
      })),
      rejected: [],
      report: { round: ctx.round, total: questions.length, passedCount: questions.length, rejectedCount: 0, letterDistribution: { passed: true }, rejections: [] },
    }),
  };
}

// QA stub that rejects every question (drives the FAILED authoring path).
function rejectAllQa() {
  return {
    runQa: async (questions) => ({
      passed: [],
      rejected: questions.map((q) => ({ question: q, reasons: ['judge_reject'] })),
      report: { total: questions.length, passedCount: 0, rejectedCount: questions.length, letterDistribution: { passed: true }, rejections: questions.map(() => ({ reasons: ['judge_reject'] })) },
    }),
  };
}

// ---------------------------------------------------------------------------
// authorMcq — happy path: over-generate → QA gates → freeze ready pool
// ---------------------------------------------------------------------------

test('authorMcq over-generates a pool, runs QA, freezes ready pool with per-item qa', async () => {
  const assessment = makeAssessment(); // totalQuestions: 10
  let generateQuizArgs = null;
  let deletedId = null;
  let markModifiedCalled = false;
  let savedCalled = false;

  assessment.markModified = function () { markModifiedCalled = true; };
  assessment.save = async function () { savedCalled = true; return this; };

  const deps = {
    Assessment: {
      findById: async (id) => { assert.strictEqual(String(id), 'assess1'); return assessment; },
    },
    Quiz: { findByIdAndDelete: async (id) => { deletedId = String(id); } },
    quizGenerationService: {
      generateQuiz: async (args) => { generateQuizArgs = args; return makeQuizN(15); },
    },
    questionQaService: passThroughQa(),
  };

  const result = await authorMcq('assess1', deps);

  // generateQuiz called with over-generated pool count (10 × 1.5 = 15)
  assert.ok(generateQuizArgs, 'generateQuiz should have been called');
  assert.strictEqual(generateQuizArgs.userId, 'user1');
  assert.strictEqual(generateQuizArgs.topic, 'JavaScript');
  assert.strictEqual(generateQuizArgs.questionCount, 15, 'over-generates the pool ×1.5');
  assert.strictEqual(generateQuizArgs.assessmentType, 'mixed');
  assert.strictEqual(generateQuizArgs.isSkillAssessment, true);
  assert.strictEqual(generateQuizArgs.suppressNotification, true);
  assert.strictEqual(generateQuizArgs.noObjective, true);

  // Whole QA-passed pool frozen; per-student count recorded separately.
  assert.strictEqual(result.config.mcq.questions.length, 15);
  assert.strictEqual(result.config.mcq.questionCount, 10, 'per-student count = target');
  assert.strictEqual(result.config.mcq.totalQuestions, 10);
  assert.strictEqual(result.config.mcq.authoring.status, 'ready');
  assert.ok(result.config.mcq.authoring.qaReport, 'qaReport persisted');
  assert.ok(result.config.mcq.questions[0].qa, 'per-item qa persisted on frozen question');

  assert.strictEqual(markModifiedCalled, true, 'markModified must be called');
  assert.strictEqual(savedCalled, true, 'save must be called');
  assert.strictEqual(deletedId, 'q1', 'throwaway quiz deleted');
});

test('authorMcq marks authoring FAILED (honest status) when QA cannot reach the target', async () => {
  const assessment = makeAssessment();
  const deps = {
    Assessment: { findById: async () => assessment },
    Quiz: { findByIdAndDelete: async () => {} },
    quizGenerationService: { generateQuiz: async () => makeQuizN(6) },
    questionQaService: rejectAllQa(),
  };

  const result = await authorMcq('assess1', deps);
  assert.strictEqual(result.config.mcq.authoring.status, 'failed');
  assert.match(result.config.mcq.authoring.error, /0\/10/);
  // Questions must NOT be frozen on failure (release gate stays blocked).
  assert.strictEqual((result.config.mcq.questions || []).length, 0, 'no questions frozen on failure');
});

test('authorMcq uses assessment.title as topic when config.mcq.topic is absent', async () => {
  const assessment = makeAssessment();
  assessment.config.mcq.topic = undefined;
  let capturedTopic = null;

  const deps = {
    Assessment: { findById: async () => assessment },
    Quiz: { findByIdAndDelete: async () => {} },
    quizGenerationService: { generateQuiz: async (args) => { capturedTopic = args.topic; return makeQuizN(15); } },
    questionQaService: passThroughQa(),
  };

  await authorMcq('assess1', deps);
  assert.strictEqual(capturedTopic, 'JavaScript Fundamentals', 'falls back to assessment.title');
});

test('authorMcq uses defaults when totalQuestions and assessmentType are absent', async () => {
  const assessment = makeAssessment();
  assessment.config.mcq.totalQuestions = undefined;
  assessment.config.mcq.assessmentType = undefined;
  let capturedArgs = null;

  const deps = {
    Assessment: { findById: async () => assessment },
    Quiz: { findByIdAndDelete: async () => {} },
    quizGenerationService: { generateQuiz: async (args) => { capturedArgs = args; return makeQuizN(15); } },
    questionQaService: passThroughQa(),
  };

  await authorMcq('assess1', deps);
  assert.strictEqual(capturedArgs.questionCount, 15, 'default target 10 → pool 15');
  assert.strictEqual(capturedArgs.assessmentType, 'mixed');
});

// ---------------------------------------------------------------------------
// authorMcq — non-mcq returns null without calling generateQuiz
// ---------------------------------------------------------------------------

test('authorMcq returns null without calling generateQuiz for non-mcq type', async () => {
  const assessment = makeAssessment({ type: 'interview' });
  let generateCalled = false;

  const deps = {
    Assessment: { findById: async () => assessment },
    Quiz: { findByIdAndDelete: async () => {} },
    quizGenerationService: { generateQuiz: async () => { generateCalled = true; return makeQuiz(); } },
  };

  const result = await authorMcq('assess1', deps);
  assert.strictEqual(result, null, 'should return null for non-mcq type');
  assert.strictEqual(generateCalled, false, 'generateQuiz must NOT be called for non-mcq');
});

test('authorMcq returns null without calling generateQuiz for capstone type', async () => {
  const assessment = makeAssessment({ type: 'capstone' });
  let generateCalled = false;

  const deps = {
    Assessment: { findById: async () => assessment },
    Quiz: { findByIdAndDelete: async () => {} },
    quizGenerationService: { generateQuiz: async () => { generateCalled = true; return makeQuiz(); } },
  };

  const result = await authorMcq('assess1', deps);
  assert.strictEqual(result, null);
  assert.strictEqual(generateCalled, false);
});

// ---------------------------------------------------------------------------
// authorMcq — NOT_FOUND throws
// ---------------------------------------------------------------------------

test('authorMcq throws Error("NOT_FOUND") when assessment does not exist', async () => {
  const deps = {
    Assessment: { findById: async () => null },
    Quiz: { findByIdAndDelete: async () => {} },
    quizGenerationService: { generateQuiz: async () => makeQuiz() },
  };

  await assert.rejects(
    () => authorMcq('missing-id', deps),
    (err) => { assert.strictEqual(err.message, 'NOT_FOUND'); return true; }
  );
});

// ---------------------------------------------------------------------------
// authorMcq — best-effort delete + guard
// ---------------------------------------------------------------------------

test('authorMcq does not throw even if Quiz.findByIdAndDelete rejects', async () => {
  const assessment = makeAssessment();

  const deps = {
    Assessment: { findById: async () => assessment },
    Quiz: { findByIdAndDelete: async () => { throw new Error('DB_DOWN'); } },
    quizGenerationService: { generateQuiz: async () => makeQuizN(15) },
    questionQaService: passThroughQa(),
  };

  const result = await authorMcq('assess1', deps);
  assert.ok(result, 'should still return updated assessment despite delete failure');
  assert.strictEqual(result.config.mcq.authoring.status, 'ready');
});

test('authorMcq works when Quiz.findByIdAndDelete is not a function (guard)', async () => {
  const assessment = makeAssessment();

  const deps = {
    Assessment: { findById: async () => assessment },
    Quiz: {}, // no findByIdAndDelete
    quizGenerationService: { generateQuiz: async () => makeQuizN(15) },
    questionQaService: passThroughQa(),
  };

  const result = await authorMcq('assess1', deps);
  assert.ok(result, 'should not crash when findByIdAndDelete is absent');
});

// ---------------------------------------------------------------------------
// authorCapstone tests
// ---------------------------------------------------------------------------

function makeCapstoneAssessment(overrides = {}) {
  return {
    _id: 'assess-cap-1',
    type: 'capstone',
    title: 'Capstone: Build a REST API',
    createdBy: 'user-cap-1',
    config: {
      capstone: {
        roleTrack: 'swe',
        difficulty: 'medium',
      },
    },
    markModified: function () {},
    save: async function () { return this; },
    ...overrides,
  };
}

function makeCapstoneAssessmentWithConfig(configOverrides = {}) {
  const base = makeCapstoneAssessment();
  base.config.capstone = { ...base.config.capstone, ...configOverrides };
  return base;
}

function makeCapstoneDeps(overrides = {}) {
  return {
    Assessment: {
      findById: async () => makeCapstoneAssessment(),
    },
    ArtifactBundle: {
      findById: async () => ({ status: 'active', type: 'capstone' }),
    },
    CapstoneGenerationRequest: {
      findById: async (id) => ({ _id: id, status: 'ready', bundle_id: 'b1' }),
    },
    requestGeneration: async () => ({ _id: 'req1' }),
    sleep: async () => {},
    pollMs: 0,
    maxPolls: 2,
    ...overrides,
  };
}

test('authorCapstone happy path: stub requestGeneration → reqDoc id; stub CapstoneGenerationRequest.findById → {status:"ready", bundle_id:"b1"}; sleep no-op → writes config.capstone.bundleId="b1", markModified, save', async () => {
  const assessment = makeCapstoneAssessment();
  let markModifiedCalled = false;
  let savedCalled = false;
  assessment.markModified = function () { markModifiedCalled = true; };
  assessment.save = async function () { savedCalled = true; return this; };

  const deps = makeCapstoneDeps({
    Assessment: { findById: async () => assessment },
  });

  const result = await authorCapstone('assess-cap-1', deps);

  assert.ok(result, 'should return the assessment');
  assert.strictEqual(String(result.config.capstone.bundleId), 'b1');
  assert.strictEqual(markModifiedCalled, true, 'markModified must be called');
  assert.strictEqual(savedCalled, true, 'save must be called');
});

test('authorCapstone idempotent: when bundleId already set and ArtifactBundle is active+capstone → returns assessment without calling requestGeneration', async () => {
  const assessment = makeCapstoneAssessmentWithConfig({ bundleId: 'existing-bundle' });
  let requestGenerationCalled = false;

  const deps = makeCapstoneDeps({
    Assessment: { findById: async () => assessment },
    requestGeneration: async () => { requestGenerationCalled = true; return { _id: 'req1' }; },
  });

  const result = await authorCapstone('assess-cap-1', deps);

  assert.ok(result, 'should return the assessment');
  assert.strictEqual(requestGenerationCalled, false, 'requestGeneration must NOT be called when bundle already active');
});

test('authorCapstone throws CAPSTONE_GEN_FAILED when poll returns status="failed"', async () => {
  const assessment = makeCapstoneAssessment();

  const deps = makeCapstoneDeps({
    Assessment: { findById: async () => assessment },
    CapstoneGenerationRequest: {
      findById: async (id) => ({ _id: id, status: 'failed' }),
    },
  });

  await assert.rejects(
    () => authorCapstone('assess-cap-1', deps),
    (err) => {
      assert.strictEqual(err.message, 'CAPSTONE_GEN_FAILED');
      return true;
    }
  );
});

test('authorCapstone returns null for non-capstone type', async () => {
  const assessment = makeCapstoneAssessment({ type: 'mcq' });
  const deps = makeCapstoneDeps({
    Assessment: { findById: async () => assessment },
  });

  const result = await authorCapstone('assess-cap-1', deps);
  assert.strictEqual(result, null);
});

test('authorCapstone throws NOT_FOUND when assessment not found', async () => {
  const deps = makeCapstoneDeps({
    Assessment: { findById: async () => null },
  });

  await assert.rejects(
    () => authorCapstone('missing-id', deps),
    (err) => {
      assert.strictEqual(err.message, 'NOT_FOUND');
      return true;
    }
  );
});

test('authorCapstone throws CAPSTONE_GEN_FAILED on timeout (maxPolls exhausted)', async () => {
  const assessment = makeCapstoneAssessment();
  // Always returns 'queued' → never becomes 'ready' or 'failed'
  const deps = makeCapstoneDeps({
    Assessment: { findById: async () => assessment },
    CapstoneGenerationRequest: {
      findById: async (id) => ({ _id: id, status: 'queued' }),
    },
    maxPolls: 2,
  });

  await assert.rejects(
    () => authorCapstone('assess-cap-1', deps),
    (err) => {
      assert.strictEqual(err.message, 'CAPSTONE_GEN_FAILED');
      return true;
    }
  );
});

test('authorCapstone passes institution ownership to requestGeneration — no userId key, assessment.createdBy goes on requestedByInstitutionUserId', async () => {
  // Regression guard for the original bug: authorCapstone used to call
  // requestGeneration({ userId: assessment.createdBy, ... }) — createdBy is
  // an InstitutionUser id, not a User id. It must now pass institution
  // ownership instead, and never a `userId` key at all.
  const assessment = makeCapstoneAssessment({
    institutionId: 'inst-1',
    cohortId: 'cohort-1',
    createdBy: 'institution-user-1',
  });

  let capturedParams = null;
  const deps = makeCapstoneDeps({
    Assessment: { findById: async () => assessment },
    requestGeneration: async (params) => { capturedParams = params; return { _id: 'req1' }; },
  });

  await authorCapstone('assess-cap-1', deps);

  assert.ok(capturedParams, 'requestGeneration should have been called');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(capturedParams, 'userId'), false, 'must not pass a userId key');
  assert.strictEqual(capturedParams.institutionId, 'inst-1');
  assert.strictEqual(capturedParams.cohortId, 'cohort-1');
  assert.strictEqual(capturedParams.assessmentId, 'assess-cap-1');
  assert.strictEqual(capturedParams.requestedByInstitutionUserId, 'institution-user-1');
});

test('authorCapstone still requests generation when createdBy is absent (the exact scenario that used to crash with "user_id is required")', async () => {
  const assessment = makeCapstoneAssessment({
    institutionId: 'inst-1',
    cohortId: 'cohort-1',
    createdBy: undefined,
  });

  let capturedParams = null;
  const deps = makeCapstoneDeps({
    Assessment: { findById: async () => assessment },
    requestGeneration: async (params) => { capturedParams = params; return { _id: 'req1' }; },
  });

  const result = await authorCapstone('assess-cap-1', deps);

  assert.ok(result, 'authorCapstone must succeed even without a createdBy');
  assert.strictEqual(capturedParams.institutionId, 'inst-1');
  assert.strictEqual(capturedParams.requestedByInstitutionUserId, undefined);
});

// ---------------------------------------------------------------------------
// Anti-masking: strict-validator stub tests
//
// These tests inject a CapstoneGenerationRequest stub whose create() method
// enforces the real Mongoose model contract (required: language, role_track
// enum ['swe','ds','ai_eng'], difficulty enum ['easy','medium','hard']).
// This ensures the service's defaults satisfy the contract and that future
// regressions (passing undefined language or invalid enum values) are caught
// immediately rather than silently failing in fire-and-forget paths.
// ---------------------------------------------------------------------------

/**
 * Strict stub that mimics Mongoose required/enum validation.
 * Throws if any contract field is missing or out-of-enum.
 */
function makeStrictCapstoneGenerationRequest() {
  const VALID_ROLE_TRACKS = ['swe', 'ds', 'ai_eng'];
  const VALID_DIFFICULTIES = ['easy', 'medium', 'hard'];
  const created = [];
  const stub = {
    __created: created,
    create: async function (doc) {
      if (!doc.language) {
        throw new Error('ValidationError: language is required');
      }
      if (!VALID_ROLE_TRACKS.includes(doc.role_track)) {
        throw new Error(`ValidationError: role_track "${doc.role_track}" not in enum`);
      }
      if (!VALID_DIFFICULTIES.includes(doc.difficulty)) {
        throw new Error(`ValidationError: difficulty "${doc.difficulty}" not in enum`);
      }
      const saved = { _id: `req-${created.length + 1}`, status: 'queued', ...doc };
      created.push(saved);
      return saved;
    },
  };
  return stub;
}

test('authorCapstone with empty config.capstone: strict-validator stub succeeds — service defaults language + roleTrack=swe + difficulty=medium', async () => {
  // Assessment with NO roleTrack, NO difficulty, NO language — all must be defaulted.
  const assessment = {
    _id: 'assess-strict-1',
    type: 'capstone',
    title: 'Test Capstone',
    createdBy: 'user-strict-1',
    config: { capstone: {} },
    markModified: function () {},
    save: async function () { return this; },
  };

  const strictStub = makeStrictCapstoneGenerationRequest();

  // Wire: pass the strict stub as CapstoneGenerationRequest in deps.
  // authorCapstone passes deps to requestGenerationFn; capstoneAuthoringSupport.requestGeneration
  // reads deps.CapstoneGenerationRequest — so the strict stub is used for the real .create() call.
  const deps = {
    Assessment: { findById: async () => assessment },
    ArtifactBundle: { findById: async () => null },
    CapstoneGenerationRequest: strictStub,
    // Use the real requestGeneration from capstoneAuthoringSupport so the stub flows through it.
    requestGeneration: require('../../coding/services/capstoneAuthoringSupport').requestGeneration,
    // But we need to intercept enqueueGeneration to avoid Redis.
    sleep: async () => {},
    pollMs: 0,
    maxPolls: 2,
  };

  // Patch: capstoneGenerationWorker.enqueueGeneration will be called by requestGeneration.
  // We need to inject it via deps too. We'll wrap requestGeneration to inject capstoneGenerationWorker.
  deps.requestGeneration = async (params, innerDeps) => {
    return require('../../coding/services/capstoneAuthoringSupport').requestGeneration(params, {
      ...innerDeps,
      CapstoneGenerationRequest: strictStub,
      capstoneGenerationWorker: { enqueueGeneration: async () => {} },
    });
  };

  // Override CapstoneGenerationRequest.findById to return 'ready' after creation.
  strictStub.findById = async (id) => ({ _id: id, status: 'ready', bundle_id: 'bundle-strict-1' });

  // authorCapstone must succeed (not throw a ValidationError).
  const result = await authorCapstone('assess-strict-1', deps);

  assert.ok(result, 'authorCapstone should return the assessment');
  assert.strictEqual(String(result.config.capstone.bundleId), 'bundle-strict-1');

  // The strict stub must have been called with a valid doc.
  assert.strictEqual(strictStub.__created.length, 1, 'CapstoneGenerationRequest.create was called once');
  const created = strictStub.__created[0];
  assert.ok(created.language, 'language must not be empty (was defaulted by service)');
  assert.ok(['swe', 'ds', 'ai_eng'].includes(created.role_track),
    `role_track "${created.role_track}" must be a valid enum value`);
  assert.ok(['easy', 'medium', 'hard'].includes(created.difficulty),
    `difficulty "${created.difficulty}" must be a valid enum value`);
  // Specifically, the service defaults: roleTrack → 'swe', difficulty → 'medium', language → 'javascript'
  assert.strictEqual(created.role_track, 'swe', 'roleTrack defaults to swe');
  assert.strictEqual(created.difficulty, 'medium', 'difficulty defaults to medium');
  assert.strictEqual(created.language, 'javascript', 'language defaults to javascript for swe track');
});

test('createAssessment rejects invalid roleTrack (BAD_CONFIG) — validates the whitelist guard in assessmentService', async () => {
  const deps = {
    Assessment: { create: async () => ({}) },
    InstitutionCohort: { findOne: async () => ({ _id: 'c1' }) },
  };
  await assert.rejects(
    () => createAssessment(
      { institutionId: 'i1' },
      { cohortId: 'c1', type: 'capstone', title: 'T', config: { capstone: { roleTrack: 'backend_engineer' } } },
      deps
    ),
    (err) => {
      assert.strictEqual(err.message, 'BAD_CONFIG', 'invalid roleTrack must throw BAD_CONFIG');
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// authorMcq — sourceId grounding
// ---------------------------------------------------------------------------

test('authorMcq with sourceId (ready): creates transient Content with keyConcepts, passes contentIds to generateQuiz, deletes transient Content', async () => {
  const mongoose = require('mongoose');
  const transientId = new mongoose.Types.ObjectId();
  const assessment = makeAssessment({
    config: {
      mcq: {
        topic: 'Data Structures',
        totalQuestions: 5,
        assessmentType: 'mixed',
        questions: [],
        sourceId: 'src1',
      },
    },
  });

  let contentCreated = null;
  let contentDeletedId = null;
  let generateQuizArgs = null;

  const deps = {
    Assessment: { findById: async () => assessment },
    Quiz: { findByIdAndDelete: async () => {} },
    Content: {
      create: async (doc) => {
        contentCreated = doc;
        return { _id: transientId, ...doc };
      },
      findByIdAndDelete: async (id) => {
        contentDeletedId = String(id);
      },
    },
    AssessmentSource: {
      findById: async (id) => ({
        _id: 'src1',
        status: 'ready',
        extractedText: 'Chapter 1: Linked Lists. Chapter 2: Trees.',
        extractedTopics: [{ name: 'Linked Lists' }, { name: 'Trees' }, { name: 'Graphs' }],
      }),
    },
    quizGenerationService: {
      generateQuiz: async (args) => {
        generateQuizArgs = args;
        return makeQuizN(8); // target 5 → pool 8
      },
    },
    questionQaService: passThroughQa(),
  };

  const result = await authorMcq('assess1', deps);

  // generateQuiz called with contentIds containing the transient Content _id
  assert.ok(generateQuizArgs, 'generateQuiz must be called');
  assert.ok(Array.isArray(generateQuizArgs.contentIds), 'contentIds should be an array');
  assert.strictEqual(generateQuizArgs.contentIds.length, 1, 'contentIds should have 1 entry');
  assert.strictEqual(String(generateQuizArgs.contentIds[0]), String(transientId));

  // Real grounding text now passed into generation (additive param).
  assert.strictEqual(generateQuizArgs.groundingText, 'Chapter 1: Linked Lists. Chapter 2: Trees.');

  // Transient Content created with correct structure
  assert.ok(contentCreated, 'Content.create should have been called');
  assert.strictEqual(contentCreated.contentType, 'notes');
  assert.strictEqual(contentCreated.ocrText, 'Chapter 1: Linked Lists. Chapter 2: Trees.');
  assert.deepStrictEqual(contentCreated.aiData.keyConcepts, [
    { concept: 'Linked Lists', description: '', importance: 5 },
    { concept: 'Trees', description: '', importance: 5 },
    { concept: 'Graphs', description: '', importance: 5 },
  ]);

  // Transient Content deleted after
  assert.strictEqual(contentDeletedId, String(transientId), 'transient Content must be deleted');

  // Assessment updated with the QA-passed pool
  assert.ok(result, 'should return assessment');
  assert.strictEqual(result.config.mcq.questions.length, 8);
  assert.strictEqual(result.config.mcq.authoring.status, 'ready');
});

test('authorMcq with sourceId but source not ready: falls back to topic-based (no contentIds)', async () => {
  const assessment = makeAssessment({
    config: {
      mcq: { topic: 'Algorithms', totalQuestions: 5, assessmentType: 'mixed', questions: [], sourceId: 'src1' },
    },
  });

  let generateQuizArgs = null;
  let contentCreated = false;

  const deps = {
    Assessment: { findById: async () => assessment },
    Quiz: { findByIdAndDelete: async () => {} },
    Content: {
      create: async () => { contentCreated = true; return { _id: 'tid1' }; },
      findByIdAndDelete: async () => {},
    },
    AssessmentSource: {
      findById: async () => ({ _id: 'src1', status: 'extracting' }), // not ready
    },
    quizGenerationService: {
      generateQuiz: async (args) => { generateQuizArgs = args; return makeQuizN(8); },
    },
    questionQaService: passThroughQa(),
  };

  await authorMcq('assess1', deps);

  // Content should NOT have been created (no grounding)
  assert.strictEqual(contentCreated, false, 'transient Content must NOT be created when source not ready');
  // contentIds + groundingText should be undefined (not passed)
  assert.strictEqual(generateQuizArgs.contentIds, undefined, 'contentIds should be absent when source not ready');
  assert.strictEqual(generateQuizArgs.groundingText, undefined, 'groundingText should be absent when source not ready');
});

test('authorMcq with sourceId but source not found: falls back to topic-based', async () => {
  const assessment = makeAssessment({
    config: {
      mcq: { topic: 'OS', totalQuestions: 5, assessmentType: 'mixed', questions: [], sourceId: 'missing' },
    },
  });

  let generateQuizArgs = null;

  const deps = {
    Assessment: { findById: async () => assessment },
    Quiz: { findByIdAndDelete: async () => {} },
    Content: { create: async () => { throw new Error('should not be called'); }, findByIdAndDelete: async () => {} },
    AssessmentSource: { findById: async () => null },
    quizGenerationService: {
      generateQuiz: async (args) => { generateQuizArgs = args; return makeQuizN(8); },
    },
    questionQaService: passThroughQa(),
  };

  await authorMcq('assess1', deps);
  assert.strictEqual(generateQuizArgs.contentIds, undefined);
});

test('authorMcq without sourceId: behaves as before (no Content created, no contentIds)', async () => {
  const assessment = makeAssessment(); // no sourceId in config.mcq
  let contentCreated = false;
  let generateQuizArgs = null;

  const deps = {
    Assessment: { findById: async () => assessment },
    Quiz: { findByIdAndDelete: async () => {} },
    Content: { create: async () => { contentCreated = true; return { _id: 'tid' }; }, findByIdAndDelete: async () => {} },
    AssessmentSource: { findById: async () => { throw new Error('should not be called'); } },
    quizGenerationService: {
      generateQuiz: async (args) => { generateQuizArgs = args; return makeQuizN(15); },
    },
    questionQaService: passThroughQa(),
  };

  await authorMcq('assess1', deps);
  assert.strictEqual(contentCreated, false, 'Content.create must NOT be called when no sourceId');
  assert.strictEqual(generateQuizArgs.contentIds, undefined);
  assert.strictEqual(generateQuizArgs.groundingText, undefined);
});

// ---------------------------------------------------------------------------
// authorCapstone — sourceId grounding
// ---------------------------------------------------------------------------

test('authorCapstone with sourceId (ready): uses source extractedText (truncated 2000) as jobDescription', async () => {
  const longText = 'A'.repeat(3000);
  const assessment = makeCapstoneAssessmentWithConfig({ sourceId: 'src1' });
  let capturedJobDescription = null;

  const deps = makeCapstoneDeps({
    Assessment: { findById: async () => assessment },
    AssessmentSource: {
      findById: async () => ({
        _id: 'src1',
        status: 'ready',
        extractedText: longText,
      }),
    },
    requestGeneration: async (params) => {
      capturedJobDescription = params.jobDescription;
      return { _id: 'req1' };
    },
  });

  await authorCapstone('assess-cap-1', deps);

  assert.ok(capturedJobDescription, 'jobDescription must be set');
  assert.strictEqual(capturedJobDescription.length, 2000, 'jobDescription should be truncated to 2000 chars');
  assert.ok(capturedJobDescription.startsWith('A'), 'should be the source text');
});

test('authorCapstone with sourceId but source not ready: falls back to cfg.jobDescription', async () => {
  const assessment = makeCapstoneAssessmentWithConfig({
    sourceId: 'src1',
    jobDescription: 'Build a REST API',
  });
  let capturedJobDescription = null;

  const deps = makeCapstoneDeps({
    Assessment: { findById: async () => assessment },
    AssessmentSource: {
      findById: async () => ({ _id: 'src1', status: 'extracting' }), // not ready
    },
    requestGeneration: async (params) => {
      capturedJobDescription = params.jobDescription;
      return { _id: 'req1' };
    },
  });

  await authorCapstone('assess-cap-1', deps);
  assert.strictEqual(capturedJobDescription, 'Build a REST API', 'should fall back to cfg.jobDescription');
});

test('authorCapstone without sourceId: uses cfg.jobDescription as before', async () => {
  const assessment = makeCapstoneAssessmentWithConfig({ jobDescription: 'Existing JD' });
  let capturedJobDescription = null;

  const deps = makeCapstoneDeps({
    Assessment: { findById: async () => assessment },
    requestGeneration: async (params) => {
      capturedJobDescription = params.jobDescription;
      return { _id: 'req1' };
    },
  });

  await authorCapstone('assess-cap-1', deps);
  assert.strictEqual(capturedJobDescription, 'Existing JD');
});

// ---------------------------------------------------------------------------
// authorDrill tests
// ---------------------------------------------------------------------------

function makeDrillAssessment(overrides = {}) {
  return {
    _id: 'assess-drill-1',
    type: 'drill',
    title: 'Prompt Engineering Drill',
    createdBy: 'user-drill-1',
    config: {
      drill: {
        drillSubtype: 'prompt',
        roleTrack: 'swe',
        difficulty: 'medium',
      },
    },
    markModified: function () {},
    save: async function () { return this; },
    ...overrides,
  };
}

test('authorDrill selects an active drill bundle matching config and saves bundleId', async () => {
  const assessment = makeDrillAssessment();
  let markModifiedCalled = false;
  let savedCalled = false;
  assessment.markModified = () => { markModifiedCalled = true; };
  assessment.save = async function () { savedCalled = true; return this; };

  const fakeBundle = { _id: 'bundle-d1', type: 'drill', status: 'active' };
  const deps = {
    Assessment: { findById: async () => assessment },
    ArtifactBundle: {
      findById: async () => null, // no pre-existing bundleId
      findOne: async () => fakeBundle,
    },
  };

  const result = await authorDrill('assess-drill-1', deps);
  assert.ok(result, 'should return assessment');
  assert.strictEqual(String(result.config.drill.bundleId), 'bundle-d1');
  assert.strictEqual(markModifiedCalled, true);
  assert.strictEqual(savedCalled, true);
});

test('authorDrill is idempotent when bundleId already set and bundle is active+drill', async () => {
  const assessment = makeDrillAssessment();
  assessment.config.drill.bundleId = 'existing-bundle';
  let findOneCalled = false;

  const deps = {
    Assessment: { findById: async () => assessment },
    ArtifactBundle: {
      findById: async () => ({ _id: 'existing-bundle', status: 'active', type: 'drill' }),
      findOne: async () => { findOneCalled = true; return null; },
    },
  };

  const result = await authorDrill('assess-drill-1', deps);
  assert.ok(result);
  assert.strictEqual(findOneCalled, false, 'findOne must NOT be called when bundle already active');
});

test('authorDrill leaves bundleId unset when no active bundle found', async () => {
  const assessment = makeDrillAssessment();
  const deps = {
    Assessment: { findById: async () => assessment },
    ArtifactBundle: {
      findById: async () => null,
      findOne: async () => null, // no matching bundle
    },
  };

  const result = await authorDrill('assess-drill-1', deps);
  assert.ok(result, 'should return assessment even if no bundle found');
  assert.ok(!result.config.drill.bundleId, 'bundleId should remain unset');
});

test('authorDrill returns null for non-drill type', async () => {
  const assessment = makeDrillAssessment({ type: 'capstone' });
  const deps = {
    Assessment: { findById: async () => assessment },
    ArtifactBundle: { findById: async () => null, findOne: async () => null },
  };
  const result = await authorDrill('assess-drill-1', deps);
  assert.strictEqual(result, null);
});

test('authorDrill throws NOT_FOUND when assessment not found', async () => {
  const deps = {
    Assessment: { findById: async () => null },
    ArtifactBundle: { findById: async () => null, findOne: async () => null },
  };
  await assert.rejects(
    () => authorDrill('missing-id', deps),
    (err) => { assert.strictEqual(err.message, 'NOT_FOUND'); return true; }
  );
});

// ---------------------------------------------------------------------------
// C1 anti-regression: real Content model validates the transient doc shape
//
// Rationale: stub-based tests (above) verified the service flow but could not
// catch a schema mismatch — the stub's Content.create() accepted anything.
// This test runs the REAL Content model's validateSync() on the exact document
// shape that authorMcq builds, ensuring importance is a Number not a String.
// If anyone accidentally reverts importance back to 'high' (string) this test
// will catch it immediately, before the silent fire-and-forget failure path.
// ---------------------------------------------------------------------------

test('C1 anti-regression: transient Content doc shape passes real Content.validateSync()', () => {
  const Content = require('../../models/Content');

  // Mirror the exact transient doc constructed by authorMcq when a ready source
  // has extractedTopics — including the importance value that must be numeric.
  const extractedTopics = [{ name: 'Linked Lists' }, { name: 'Trees' }];
  const keyConcepts = extractedTopics.map((t) => ({
    concept: t.name,
    description: '',
    importance: 5, // MUST be Number — schema: {type:Number,min:1,max:5}
  }));

  const doc = new Content({
    title: 'Transient Assessment Source: test assessment',
    contentType: 'notes',
    domain: 'general',
    contentURL: 'transient',
    ocrText: 'Sample extracted text.',
    aiData: { keyConcepts },
    status: 'draft',
  });

  const validationError = doc.validateSync();

  assert.strictEqual(
    validationError,
    undefined,
    `Real Content.validateSync() should return no error for transient doc shape, but got: ${validationError}`
  );

  // Confirm keyConcepts were set correctly
  assert.strictEqual(doc.aiData.keyConcepts.length, 2);
  assert.strictEqual(typeof doc.aiData.keyConcepts[0].importance, 'number',
    'importance must be stored as a number');
  assert.strictEqual(doc.aiData.keyConcepts[0].importance, 5);
});

test('C1 anti-regression: string importance DOES fail Content.validateSync() (confirms guard is needed)', () => {
  const Content = require('../../models/Content');

  // Demonstrate that the old code (importance: 'high') would have thrown.
  const doc = new Content({
    title: 'Bad transient doc',
    contentType: 'notes',
    domain: 'general',
    contentURL: 'transient',
    ocrText: '',
    aiData: {
      keyConcepts: [{ concept: 'test', description: '', importance: 'high' }], // BAD: string not number
    },
    status: 'draft',
  });

  const validationError = doc.validateSync();

  assert.ok(
    validationError !== undefined,
    'Content.validateSync() MUST return a ValidationError when importance is a string'
  );
  assert.ok(
    validationError.errors && (
      validationError.errors['aiData.keyConcepts.0.importance'] ||
      Object.keys(validationError.errors).some((k) => k.includes('importance'))
    ),
    `Expected a validation error on importance field; got errors: ${JSON.stringify(Object.keys(validationError.errors))}`
  );
});

// ---------------------------------------------------------------------------
// Task 3C: authorDrill — generation-on-demand tests
// ---------------------------------------------------------------------------

test('authorDrill generates when no library bundle matches and polls until active', async () => {
  const assessment = makeDrillAssessment({
    config: {
      drill: { roleTrack: 'swe', drillSubtype: 'algo', difficulty: 'medium' },
    },
  });
  let markModifiedCalled = false;
  let savedCalled = false;
  assessment.markModified = () => { markModifiedCalled = true; };
  assessment.save = async function () { savedCalled = true; return this; };

  let generateDrillArgs = null;
  let pollCount = 0;

  const deps = {
    Assessment: { findById: async () => assessment },
    ArtifactBundle: {
      findById: async (id) => {
        if (String(id) === 'b1') {
          pollCount += 1;
          if (pollCount === 1) return { _id: 'b1', status: 'generating' };
          return { _id: 'b1', status: 'active' };
        }
        return null; // idempotent check: no pre-existing bundle
      },
      findOne: async () => null, // no library match
    },
    generateDrill: async (params) => {
      generateDrillArgs = params;
      return { ok: true, bundle_id: 'b1' };
    },
    sleep: async () => {},
    pollMs: 0,
    maxPolls: 5,
  };

  const result = await authorDrill('assess-drill-1', deps);

  assert.ok(result, 'should return assessment');
  assert.strictEqual(String(result.config.drill.bundleId), 'b1', 'bundleId should be set to b1');
  assert.strictEqual(markModifiedCalled, true, 'markModified should be called');
  assert.strictEqual(savedCalled, true, 'save should be called');

  assert.ok(generateDrillArgs, 'generateDrill should have been called');
  assert.strictEqual(generateDrillArgs.role_track, 'swe');
  assert.strictEqual(generateDrillArgs.drill_subtype, 'algo');
  assert.strictEqual(generateDrillArgs.difficulty, 'medium');
  assert.strictEqual(generateDrillArgs.language, 'javascript');
});

test('authorDrill still prefers existing active library bundle over generation', async () => {
  const assessment = makeDrillAssessment();
  let generateDrillCalled = false;

  const deps = {
    Assessment: { findById: async () => assessment },
    ArtifactBundle: {
      findById: async () => null, // no pre-existing bundleId
      findOne: async () => ({ _id: 'bundleLib', status: 'active', type: 'drill' }), // library match
    },
    generateDrill: async () => { generateDrillCalled = true; throw new Error('should not be called'); },
    sleep: async () => {},
    pollMs: 0,
    maxPolls: 5,
  };

  const result = await authorDrill('assess-drill-1', deps);

  assert.ok(result, 'should return assessment');
  assert.strictEqual(String(result.config.drill.bundleId), 'bundleLib', 'bundleId should be set from library');
  assert.strictEqual(generateDrillCalled, false, 'generateDrill must NOT be called when library bundle found');
});

test('authorDrill handles generateDrill failure gracefully without throwing', async () => {
  const assessment = makeDrillAssessment();

  const deps = {
    Assessment: { findById: async () => assessment },
    ArtifactBundle: {
      findById: async () => null,
      findOne: async () => null, // no library match
    },
    generateDrill: async () => { throw new Error('LLM_FAIL'); },
    sleep: async () => {},
    pollMs: 0,
    maxPolls: 5,
  };

  // Should resolve, not throw
  const result = await authorDrill('assess-drill-1', deps);

  assert.ok(result, 'should return assessment even when generateDrill throws');
  assert.ok(!result.config.drill.bundleId, 'bundleId should remain unset when generateDrill fails');
});

// ---------------------------------------------------------------------------
// regenerateQuestion — single-item regen through the gates
// ---------------------------------------------------------------------------

const { regenerateQuestion } = require('../../services/institution/assessment/assessmentAuthoringService');

function makeMcqWithQuestions(qs, status = 'configured') {
  return {
    _id: 'assessR',
    type: 'mcq',
    status,
    title: 'T',
    createdBy: 'user1',
    config: { mcq: { topic: 'JavaScript', assessmentType: 'mixed', questions: qs } },
    markModified() {},
    save: async function () { return this; },
  };
}

test('regenerateQuestion replaces a single item with a QA-passed one', async () => {
  const assessment = makeMcqWithQuestions([{ questionText: 'old0' }, { questionText: 'old1' }]);
  const deps = {
    Assessment: { findById: async () => assessment },
    Quiz: { findByIdAndDelete: async () => {} },
    quizGenerationService: { generateQuiz: async () => makeQuizN(3) },
    questionQaService: passThroughQa(),
  };
  const result = await regenerateQuestion('assessR', 1, deps);
  assert.strictEqual(result.config.mcq.questions[0].questionText, 'old0', 'other items untouched');
  assert.strictEqual(result.config.mcq.questions[1].questionText, 'q0', 'target item replaced with a passing question');
  assert.ok(result.config.mcq.questions[1].qa, 'replacement carries qa metadata');
});

test('regenerateQuestion throws RELEASED once the assessment is released', async () => {
  const assessment = makeMcqWithQuestions([{ questionText: 'x' }], 'released');
  const deps = { Assessment: { findById: async () => assessment } };
  await assert.rejects(() => regenerateQuestion('assessR', 0, deps), (e) => { assert.strictEqual(e.message, 'RELEASED'); return true; });
});

test('regenerateQuestion throws BAD_INDEX for an out-of-range index', async () => {
  const assessment = makeMcqWithQuestions([{ questionText: 'x' }]);
  const deps = { Assessment: { findById: async () => assessment } };
  await assert.rejects(() => regenerateQuestion('assessR', 5, deps), (e) => { assert.strictEqual(e.message, 'BAD_INDEX'); return true; });
});

test('regenerateQuestion throws REGEN_FAILED when QA never yields a passing item', async () => {
  const assessment = makeMcqWithQuestions([{ questionText: 'x' }]);
  const deps = {
    Assessment: { findById: async () => assessment },
    Quiz: { findByIdAndDelete: async () => {} },
    quizGenerationService: { generateQuiz: async () => makeQuizN(3) },
    questionQaService: rejectAllQa(),
  };
  await assert.rejects(() => regenerateQuestion('assessR', 0, deps), (e) => { assert.strictEqual(e.message, 'REGEN_FAILED'); return true; });
});

// ---------------------------------------------------------------------------
// Review fixes: crash honesty (I-1) + regen-vs-release TOCTOU guard (I-2)
// ---------------------------------------------------------------------------

test('authorMcq persists FAILED status and rethrows when QA crashes (never stuck generating)', async () => {
  const assessment = makeAssessment();
  const deps = {
    Assessment: { findById: async () => assessment },
    Quiz: { findByIdAndDelete: async () => {} },
    quizGenerationService: { generateQuiz: async () => makeQuizN(15) },
    questionQaService: { runQa: async () => { throw new Error('judge exploded'); } },
  };
  await assert.rejects(() => authorMcq('assess1', deps), /judge exploded/);
  assert.strictEqual(assessment.config.mcq.authoring.status, 'failed', 'crash must persist failed, never stuck generating');
  assert.match(assessment.config.mcq.authoring.error, /authoring crashed/);
});

test('regenerateQuestion refuses to swap a question when a release wins the race (atomic guard)', async () => {
  const { regenerateQuestion } = require('../../services/institution/assessment/assessmentAuthoringService');
  const assessment = makeAssessment();
  assessment.config.mcq.questions = [{ questionText: 'old', options: [] }];
  let conditionalFilter = null;
  const deps = {
    Assessment: {
      findById: async () => assessment,
      // Simulate a release landing between the status pre-check and the write:
      // the conditional filter matches nothing.
      updateOne: async (filter) => { conditionalFilter = filter; return { matchedCount: 0 }; },
    },
    Quiz: { findByIdAndDelete: async () => {} },
    quizGenerationService: { generateQuiz: async () => makeQuizN(3) },
    questionQaService: passThroughQa(),
  };
  await assert.rejects(() => regenerateQuestion('assess1', 0, deps), /RELEASED/);
  assert.ok(conditionalFilter && conditionalFilter.status, 'write must be conditional on unreleased status');
});
