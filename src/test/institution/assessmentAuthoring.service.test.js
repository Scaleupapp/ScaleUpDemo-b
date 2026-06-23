'use strict';
/**
 * Tests for src/services/institution/assessment/assessmentAuthoringService.js
 *
 * All deps injected — no real DB, no LLM calls.
 */
const test = require('node:test');
const assert = require('node:assert');
const { authorMcq, authorCapstone } = require('../../services/institution/assessment/assessmentAuthoringService');

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
