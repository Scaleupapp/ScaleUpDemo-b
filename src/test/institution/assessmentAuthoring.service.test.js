'use strict';
/**
 * Tests for src/services/institution/assessment/assessmentAuthoringService.js
 *
 * All deps injected — no real DB, no LLM calls.
 */
const test = require('node:test');
const assert = require('node:assert');
const { authorMcq, authorCapstone } = require('../../services/institution/assessment/assessmentAuthoringService');
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

// ---------------------------------------------------------------------------
// authorMcq — happy path for mcq type
// ---------------------------------------------------------------------------

test('authorMcq for mcq calls generateQuiz with correct args and freezes questions', async () => {
  const assessment = makeAssessment();
  let generateQuizArgs = null;
  let deletedId = null;
  let markModifiedCalled = false;
  let savedCalled = false;

  // Override markModified and save to track calls
  assessment.markModified = function (path) { markModifiedCalled = true; };
  assessment.save = async function () { savedCalled = true; return this; };

  const deps = {
    Assessment: {
      findById: async (id) => {
        assert.strictEqual(String(id), 'assess1');
        return assessment;
      },
    },
    Quiz: {
      findByIdAndDelete: async (id) => { deletedId = String(id); },
    },
    quizGenerationService: {
      generateQuiz: async (args) => {
        generateQuizArgs = args;
        return makeQuiz();
      },
    },
  };

  const result = await authorMcq('assess1', deps);

  // generateQuiz called with expected args
  assert.ok(generateQuizArgs, 'generateQuiz should have been called');
  assert.strictEqual(generateQuizArgs.userId, 'user1');
  assert.strictEqual(generateQuizArgs.topic, 'JavaScript');
  assert.strictEqual(generateQuizArgs.questionCount, 10);
  assert.strictEqual(generateQuizArgs.assessmentType, 'mixed');
  assert.strictEqual(generateQuizArgs.isSkillAssessment, true);
  assert.strictEqual(generateQuizArgs.suppressNotification, true);
  assert.strictEqual(generateQuizArgs.noObjective, true);

  // Questions frozen onto assessment
  assert.deepStrictEqual(result.config.mcq.questions, [{ questionText: 'a' }, { questionText: 'b' }]);
  assert.strictEqual(result.config.mcq.totalQuestions, 2);

  // markModified + save were called
  assert.strictEqual(markModifiedCalled, true, 'markModified must be called');
  assert.strictEqual(savedCalled, true, 'save must be called');

  // Throwaway quiz deleted
  assert.strictEqual(deletedId, 'q1', 'Quiz.findByIdAndDelete should be called with quiz._id');
});

test('authorMcq uses assessment.title as topic when config.mcq.topic is absent', async () => {
  const assessment = makeAssessment();
  assessment.config.mcq.topic = undefined;
  let capturedTopic = null;

  const deps = {
    Assessment: { findById: async () => assessment },
    Quiz: { findByIdAndDelete: async () => {} },
    quizGenerationService: {
      generateQuiz: async (args) => {
        capturedTopic = args.topic;
        return makeQuiz();
      },
    },
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
    quizGenerationService: {
      generateQuiz: async (args) => {
        capturedArgs = args;
        return makeQuiz();
      },
    },
  };

  await authorMcq('assess1', deps);
  assert.strictEqual(capturedArgs.questionCount, 10);
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
    quizGenerationService: {
      generateQuiz: async () => { generateCalled = true; return makeQuiz(); },
    },
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
    quizGenerationService: {
      generateQuiz: async () => { generateCalled = true; return makeQuiz(); },
    },
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
    (err) => {
      assert.strictEqual(err.message, 'NOT_FOUND');
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// authorMcq — Quiz delete failure is best-effort (does not throw)
// ---------------------------------------------------------------------------

test('authorMcq does not throw even if Quiz.findByIdAndDelete rejects', async () => {
  const assessment = makeAssessment();

  const deps = {
    Assessment: { findById: async () => assessment },
    Quiz: {
      findByIdAndDelete: async () => { throw new Error('DB_DOWN'); },
    },
    quizGenerationService: {
      generateQuiz: async () => makeQuiz(),
    },
  };

  // Should resolve normally; delete failure is swallowed
  const result = await authorMcq('assess1', deps);
  assert.ok(result, 'should still return updated assessment despite delete failure');
});

// ---------------------------------------------------------------------------
// authorMcq — Quiz.findByIdAndDelete guard when method absent
// ---------------------------------------------------------------------------

test('authorMcq works when Quiz.findByIdAndDelete is not a function (guard)', async () => {
  const assessment = makeAssessment();

  const deps = {
    Assessment: { findById: async () => assessment },
    Quiz: {}, // no findByIdAndDelete
    quizGenerationService: {
      generateQuiz: async () => makeQuiz(),
    },
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
        return makeQuiz();
      },
    },
  };

  const result = await authorMcq('assess1', deps);

  // generateQuiz called with contentIds containing the transient Content _id
  assert.ok(generateQuizArgs, 'generateQuiz must be called');
  assert.ok(Array.isArray(generateQuizArgs.contentIds), 'contentIds should be an array');
  assert.strictEqual(generateQuizArgs.contentIds.length, 1, 'contentIds should have 1 entry');
  assert.strictEqual(String(generateQuizArgs.contentIds[0]), String(transientId));

  // Transient Content created with correct structure
  assert.ok(contentCreated, 'Content.create should have been called');
  assert.strictEqual(contentCreated.contentType, 'notes');
  assert.strictEqual(contentCreated.ocrText, 'Chapter 1: Linked Lists. Chapter 2: Trees.');
  assert.deepStrictEqual(contentCreated.aiData.keyConcepts, [
    { concept: 'Linked Lists', description: '', importance: 'high' },
    { concept: 'Trees', description: '', importance: 'high' },
    { concept: 'Graphs', description: '', importance: 'high' },
  ]);

  // Transient Content deleted after
  assert.strictEqual(contentDeletedId, String(transientId), 'transient Content must be deleted');

  // Assessment updated with quiz questions
  assert.ok(result, 'should return assessment');
  assert.deepStrictEqual(result.config.mcq.questions, [{ questionText: 'a' }, { questionText: 'b' }]);
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
      generateQuiz: async (args) => { generateQuizArgs = args; return makeQuiz(); },
    },
  };

  await authorMcq('assess1', deps);

  // Content should NOT have been created (no grounding)
  assert.strictEqual(contentCreated, false, 'transient Content must NOT be created when source not ready');
  // contentIds should be undefined (not passed)
  assert.strictEqual(generateQuizArgs.contentIds, undefined, 'contentIds should be absent when source not ready');
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
      generateQuiz: async (args) => { generateQuizArgs = args; return makeQuiz(); },
    },
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
      generateQuiz: async (args) => { generateQuizArgs = args; return makeQuiz(); },
    },
  };

  await authorMcq('assess1', deps);
  assert.strictEqual(contentCreated, false, 'Content.create must NOT be called when no sourceId');
  assert.strictEqual(generateQuizArgs.contentIds, undefined);
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
