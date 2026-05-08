'use strict';

// E2E integration test: upskilling × PM happy path (diagnostic engine).
// Connects to MONGODB_URI_TEST (or localhost fallback). Run manually against
// a local Mongo — it will time out in CI without a reachable instance.
//
// Usage:
//   MONGODB_URI_TEST=mongodb://localhost:27017/scaleup_test \
//   node --test src/integration/diagnostic-e2e-upskilling.test.js

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGODB_URI_TEST || 'mongodb://localhost:27017/scaleup_test';

// ---------------------------------------------------------------------------
// Stubs — installed before any service is require()d
// ---------------------------------------------------------------------------

// planGenerationQueue is top-level required by diagnosticService; stub it first.
const queuePath = require.resolve('../config/queue');
require.cache[queuePath] = {
  exports: { planGenerationQueue: { add: async () => null } },
  loaded: true, id: queuePath,
};

// telemetry — fire-and-forget, stub to no-op.
const telemetryPath = require.resolve('../services/diagnosticTelemetryService');
require.cache[telemetryPath] = {
  exports: { logEvent: () => null },
  loaded: true, id: telemetryPath,
};

// userContextService — top-level required by diagnosticService for getSynthesis.
const ucPath = require.resolve('../services/userContextService');
require.cache[ucPath] = {
  exports: { get: async () => null },
  loaded: true, id: ucPath,
};

// topicTaxonomyService — canonicalize is identity, buildTargetKey returns a fixed key.
const taxSvcPath = require.resolve('../services/diagnostic/topicTaxonomyService');
require.cache[taxSvcPath] = {
  exports: {
    canonicalize: (s) => s.toLowerCase().replace(/\s+/g, '_'),
    buildTargetKey: (objectiveType, specifics) =>
      `${objectiveType}:${specifics?.targetSkill || 'product_manager'}`,
  },
  loaded: true, id: taxSvcPath,
};

// diagnosticSelectorService — totalQuestionsForAttempt returns 2 (matches fake pool).
const selectorPath = require.resolve('../services/diagnosticSelectorService');
require.cache[selectorPath] = {
  exports: {
    totalQuestionsForAttempt: () => 2,
    planType: () => 'adaptive',
    selectQuestions: (pool) => pool,
    voiceEligibleTopics: () => [],
    isStrictTimerObjective: () => false,
  },
  loaded: true, id: selectorPath,
};

// TopicTaxonomy model — findOne returns null (fall back to canonical names).
const taxModelPath = require.resolve('../models/TopicTaxonomy');
require.cache[taxModelPath] = {
  exports: { findOne: () => ({ lean: async () => null }) },
  loaded: true, id: taxModelPath,
};

// insightsGenerationService — lazy-required in finishAttempt. Stub returns
// template-style insights so the test doesn't need OPENAI_API_KEY.
const insightsSvcPath = require.resolve('../services/diagnostic/insightsGenerationService');
const fakeInsights = {
  hero: 'Strong foundation in product strategy.',
  patterns: ['Consistent across strategy', 'Gap in data analysis'],
  breakdown: [],
};
require.cache[insightsSvcPath] = {
  exports: {
    generateInsights: async () => ({ source: 'template', insights: fakeInsights }),
    _templateInsights: () => fakeInsights,
  },
  loaded: true, id: insightsSvcPath,
};

// diagnosticPoolService — assemblePool (taxonomy route) returns 2 PM questions.
const fakePmQuestions = [
  {
    _id: new mongoose.Types.ObjectId(),
    canonicalCompetency: 'product_strategy',
    difficulty: 'easy',
    questionText: 'What is a product vision?',
    options: [
      { label: 'A', text: 'A long-term goal for the product' },
      { label: 'B', text: 'A sprint backlog' },
      { label: 'C', text: 'A bug tracker' },
      { label: 'D', text: 'A release note' },
    ],
    correctAnswer: 'A',
    requiresVoice: false,
  },
  {
    _id: new mongoose.Types.ObjectId(),
    canonicalCompetency: 'data_analysis',
    difficulty: 'easy',
    questionText: 'Which metric best measures retention?',
    options: [
      { label: 'A', text: 'DAU/MAU ratio' },
      { label: 'B', text: 'Page views' },
      { label: 'C', text: 'Bounce rate' },
      { label: 'D', text: 'Ad impressions' },
    ],
    correctAnswer: 'A',
    requiresVoice: false,
  },
];

const poolSvcPath = require.resolve('../services/diagnosticPoolService');
require.cache[poolSvcPath] = {
  exports: {
    assemblePool: async () => ({ questions: fakePmQuestions }),
    _internal: { calculatePoolAllocation: () => [] },
  },
  loaded: true, id: poolSvcPath,
};

// DiagnosticQuestionBank — updateOne is a no-op, findById returns from fake pool.
const bankPath = require.resolve('../models/DiagnosticQuestionBank');
const fakeBankById = (id) => fakePmQuestions.find(q => String(q._id) === String(id)) || null;
require.cache[bankPath] = {
  exports: {
    find: () => ({ lean: async () => fakePmQuestions, sort: function() { return this; }, limit: function() { return this; } }),
    findById: async (id) => fakeBankById(id),
    updateOne: async () => null,
    insertMany: async (d) => d,
  },
  loaded: true, id: bankPath,
};

// journeyGenerationService — not on the engine happy path but may be lazy-required.
const planPath = require.resolve('../services/journeyGenerationService');
require.cache[planPath] = {
  exports: { regenerateForUser: async () => null },
  loaded: true, id: planPath,
};

// competencyNormalizer — top-level required; stub for safety.
const normPath = require.resolve('../services/competencyNormalizer');
require.cache[normPath] = {
  exports: { normalize: (s) => s.toLowerCase() },
  loaded: true, id: normPath,
};

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

test('E2E: upskilling × PM — start → answer all → finish → results + insights', { timeout: 30_000 }, async () => {
  await mongoose.connect(MONGO_URI);

  // Clean up any prior test data.
  const userId = new mongoose.Types.ObjectId();

  // Seed a UserObjective with topicSelfRatings (canonical keys, as the engine expects).
  // The engine reads this directly; submitSelfRating is a legacy pass-through.
  const UserObjective = require('../models/UserObjective');
  const objective = await UserObjective.create({
    userId,
    objectiveType: 'upskilling',
    status: 'active',
    isPrimary: true,
    specifics: { targetSkill: 'product_manager' },
    specificsCanonical: { targetSkill: 'product_manager' },
    topicSelfRatings: {
      product_strategy: 'novice',
      data_analysis: 'novice',
    },
  });

  // Fresh require of diagnosticService (after all stubs are in place).
  delete require.cache[require.resolve('../services/diagnosticService')];
  const svc = require('../services/diagnosticService');

  // ===== Start =====
  const start = await svc.startAttempt(userId);
  assert.ok(start, 'startAttempt should return a result');
  assert.ok(start.attemptId, 'should have attemptId');
  assert.strictEqual(start.flowType, 'new_user');

  const attemptId = start.attemptId;

  // ===== Answer all questions =====
  // Pool is seeded from the stub — 2 questions, both answered correctly.
  const q1Resp = await svc.nextQuestion(attemptId);
  assert.strictEqual(q1Resp.done, false, 'first question should not be done');
  assert.ok(q1Resp.question, 'first question should exist');
  const q1Id = q1Resp.question._id;
  await svc.submitAnswer(attemptId, q1Id, 'A', 12);

  const q2Resp = await svc.nextQuestion(attemptId);
  assert.strictEqual(q2Resp.done, false, 'second question should not be done');
  assert.ok(q2Resp.question, 'second question should exist');
  const q2Id = q2Resp.question._id;
  await svc.submitAnswer(attemptId, q2Id, 'A', 10);

  const q3Resp = await svc.nextQuestion(attemptId);
  assert.strictEqual(q3Resp.done, true, 'pool exhausted — should be done');

  // ===== Finish =====
  const result = await svc.finishAttempt(attemptId);

  // Core assertions
  assert.strictEqual(result.status, 'completed', 'attempt status should be completed');
  assert.ok(Array.isArray(result.results), 'results should be an array');
  assert.ok(result.results.length >= 1, 'should have at least one competency result');

  const strategyResult = result.results.find(r => r.canonicalCompetency === 'product_strategy');
  assert.ok(strategyResult, 'product_strategy result should exist');
  // Two correct at easy → familiar band
  assert.strictEqual(strategyResult.band, 'familiar', 'correct answers → familiar band');

  // Insights assertions
  assert.ok(result.insights, 'insights should be present');
  assert.ok(typeof result.insights.hero === 'string' && result.insights.hero.length > 0, 'insights.hero should be non-empty');
  assert.ok(Array.isArray(result.insights.patterns), 'insights.patterns should be an array');

  // Persisted attempt should have insightsJson set
  const DiagnosticAttempt = require('../models/DiagnosticAttempt');
  const persisted = await DiagnosticAttempt.findById(attemptId).lean();
  assert.ok(persisted, 'attempt should persist in DB');
  assert.strictEqual(persisted.status, 'completed');
  assert.ok(persisted.insightsJson, 'insightsJson should be persisted on the attempt');
  assert.ok(persisted.insightsJson.hero, 'persisted insightsJson.hero should be non-empty');

  // Cleanup
  await UserObjective.deleteOne({ _id: objective._id });
  await DiagnosticAttempt.deleteOne({ _id: attemptId });
  await mongoose.disconnect();
});
