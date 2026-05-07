const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

test('diagnostic happy-path: start → self-rate → answer all → finish', async () => {
  // ===== Stub all models and external services =====

  const userId = new mongoose.Types.ObjectId();
  let createdAttempt = null;

  const dapath = require.resolve('../models/DiagnosticAttempt');
  require.cache[dapath] = {
    exports: function FakeDA(data) {
      Object.assign(this, data);
      this._id = new mongoose.Types.ObjectId();
      // Initialize Mongoose Map-like fields with real Maps
      if (!this.selfRatings || !(this.selfRatings instanceof Map)) {
        this.selfRatings = new Map();
      }
      if (!this.results || !(this.results instanceof Map)) {
        this.results = new Map();
      }
      // Ensure arrays are initialized
      if (!Array.isArray(this.answers)) this.answers = [];
      if (!Array.isArray(this.poolQuestionIds)) this.poolQuestionIds = [];
      this.save = async () => { createdAttempt = this; return this; };
    },
    loaded: true, id: dapath,
  };
  require.cache[dapath].exports.findById = async () => createdAttempt;
  require.cache[dapath].exports.findOne = async () => null;
  require.cache[dapath].exports.updateMany = async () => ({ modifiedCount: 0 });

  const kpPath = require.resolve('../models/KnowledgeProfile');
  require.cache[kpPath] = {
    exports: { findOne: async () => null },
    loaded: true, id: kpPath,
  };

  const cmPath = require.resolve('../models/ConceptMastery');
  require.cache[cmPath] = {
    exports: { findOneAndUpdate: async () => null },
    loaded: true, id: cmPath,
  };

  const objpath = require.resolve('../models/UserObjective');
  require.cache[objpath] = {
    exports: { findOne: () => ({ lean: async () => ({
      _id: 'obj1', objectiveType: 'interview_preparation',
      analysis: { competencies: [{ name: 'sql' }] },
    }) }) },
    loaded: true, id: objpath,
  };

  const bankPath = require.resolve('../models/DiagnosticQuestionBank');
  const fakeBankDocs = [
    { _id: 'q1', canonicalCompetency: 'sql', difficulty: 'easy', questionText: 'q1', options: [
      { label: 'A', text: 'a' }, { label: 'B', text: 'b' },
      { label: 'C', text: 'c' }, { label: 'D', text: 'd' },
    ], correctAnswer: 'A' },
    { _id: 'q2', canonicalCompetency: 'sql', difficulty: 'easy', questionText: 'q2', options: [
      { label: 'A', text: 'a' }, { label: 'B', text: 'b' },
      { label: 'C', text: 'c' }, { label: 'D', text: 'd' },
    ], correctAnswer: 'A' },
  ];
  require.cache[bankPath] = {
    exports: {
      find: () => {
        // Support both .lean() (batch fetch in nextQuestion) and .sort().limit().lean() (lookupFromBank)
        const chainable = {
          lean: async () => fakeBankDocs,
          sort: () => chainable,
          limit: () => chainable,
        };
        return chainable;
      },
      findById: async (id) => ({
        _id: id, canonicalCompetency: 'sql', difficulty: 'easy',
        questionText: id, options: [
          { label: 'A', text: 'a' }, { label: 'B', text: 'b' },
          { label: 'C', text: 'c' }, { label: 'D', text: 'd' },
        ], correctAnswer: 'A',
      }),
      updateOne: async () => {},
      insertMany: async (d) => d,
    },
    loaded: true, id: bankPath,
  };

  const planPath = require.resolve('../services/journeyGenerationService');
  require.cache[planPath] = {
    exports: { regenerateForUser: async () => null },
    loaded: true, id: planPath,
  };

  const openaiPath = require.resolve('../config/openai');
  require.cache[openaiPath] = {
    exports: { chat: { completions: { create: async () => ({ choices: [{ message: { content: '{}' } }] }) } } },
    loaded: true, id: openaiPath,
  };

  // Reset module cache for service modules to use the stubs
  for (const m of [
    './diagnosticPoolService', './diagnosticSelectorService', './diagnosticService',
  ]) {
    delete require.cache[require.resolve('../services/' + m.replace('./', ''))];
  }

  const svc = require('../services/diagnosticService');

  // ===== Walk the flow =====

  const start = await svc.startAttempt(userId);
  assert.ok(start.attemptId);
  assert.strictEqual(start.flowType, 'new_user');
  // Patch poolQuestionIds since assemblePool returned 2 stub questions
  createdAttempt.poolQuestionIds = ['q1', 'q2'];

  await svc.submitSelfRating(start.attemptId, { sql: 'novice' });

  // Answer two questions correctly to converge
  const q1 = await svc.nextQuestion(start.attemptId);
  assert.ok(q1.question);
  await svc.submitAnswer(start.attemptId, q1.question.id, 'A', 5);

  const q2 = await svc.nextQuestion(start.attemptId);
  if (!q2.done) {
    await svc.submitAnswer(start.attemptId, q2.question.id, 'A', 5);
  }

  const result = await svc.finishAttempt(start.attemptId);
  assert.strictEqual(result.status, 'completed');
  assert.ok(Array.isArray(result.results), 'results should be an array');
  const sql = result.results.find(r => r.competency === 'sql');
  assert.ok(sql, 'sql result should exist');
  // Two correct at easy → familiar (not novice)
  assert.strictEqual(sql.band, 'familiar');
});

// ---------------------------------------------------------------------------
// GET /:attemptId/results — controller unit-level tests (no full flow needed)
// ---------------------------------------------------------------------------

test('GET /:attemptId/results: returns correct shape with insightsStatus + calibrationClass', async () => {
  const userId = new mongoose.Types.ObjectId();
  const attemptId = new mongoose.Types.ObjectId();

  const fakeAttempt = {
    _id: attemptId,
    userId,
    status: 'completed',
    insightsStatus: 'fallback',
    insightsJson: { hero: 'Strong in SQL', patterns: ['pattern-a'], breakdown: [] },
    appliedToProfileAt: null,
    objectiveSnapshot: null,
    results: new Map([
      ['sql', { assessedBand: 'familiar', score: 60, calibrationDelta: -10, calibrationClass: 'undersells', questionsAsked: 2 }],
    ]),
  };

  const dapath = require.resolve('../models/DiagnosticAttempt');
  require.cache[dapath] = {
    exports: function FakeDA() {},
    loaded: true, id: dapath,
  };
  require.cache[dapath].exports.findById = async () => fakeAttempt;

  // TopicTaxonomy — return null so display falls back to canonical
  const taxPath = require.resolve('../models/TopicTaxonomy');
  require.cache[taxPath] = {
    exports: { findOne: () => ({ lean: async () => null }) },
    loaded: true, id: taxPath,
  };

  // topicTaxonomyService — buildTargetKey not invoked when objectiveSnapshot is null
  const taxSvcPath = require.resolve('../services/diagnostic/topicTaxonomyService');
  require.cache[taxSvcPath] = {
    exports: { canonicalize: s => s.toLowerCase(), buildTargetKey: () => null },
    loaded: true, id: taxSvcPath,
  };

  // Re-load controller so it picks up the stubs above
  delete require.cache[require.resolve('../controllers/diagnosticController')];
  const ctrl = require('../controllers/diagnosticController');

  const req = { params: { attemptId: String(attemptId) }, user: { id: String(userId) } };
  let captured;
  let statusCode;
  const res = {
    status: function (c) { statusCode = c; return this; },
    json: function (b) { captured = b; return this; },
  };
  await ctrl.getResults(req, res);

  assert.strictEqual(statusCode, 200);
  assert.strictEqual(captured.attemptId, String(attemptId));
  assert.strictEqual(captured.status, 'completed');
  assert.ok(['completed', 'fallback', 'generating', 'pending'].includes(captured.insightsStatus));
  assert.ok(captured.insights, 'insights JSON present');
  assert.ok(typeof captured.insights.hero === 'string');
  assert.ok(Array.isArray(captured.insights.patterns));
  assert.strictEqual(captured.planStatus, 'pending');
  assert.ok(Array.isArray(captured.results));
  for (const r of captured.results) {
    assert.ok(['well-calibrated', 'overestimates', 'undersells'].includes(r.calibrationClass));
    assert.ok(typeof r.canonicalCompetency === 'string');
  }
});

test('GET /:attemptId/results: 404 for missing attempt', async () => {
  const dapath = require.resolve('../models/DiagnosticAttempt');
  require.cache[dapath] = {
    exports: function FakeDA() {},
    loaded: true, id: dapath,
  };
  require.cache[dapath].exports.findById = async () => null;

  delete require.cache[require.resolve('../controllers/diagnosticController')];
  const ctrl = require('../controllers/diagnosticController');

  const req = { params: { attemptId: String(new mongoose.Types.ObjectId()) }, user: { id: String(new mongoose.Types.ObjectId()) } };
  let captured;
  let statusCode;
  const res = {
    status: function (c) { statusCode = c; return this; },
    json: function (b) { captured = b; return this; },
  };
  await ctrl.getResults(req, res);
  assert.strictEqual(statusCode, 404);
  assert.strictEqual(captured.error, 'attempt_not_found');
});

test('GET /:attemptId/results: 403 for wrong user', async () => {
  const userId = new mongoose.Types.ObjectId();
  const attemptId = new mongoose.Types.ObjectId();

  const fakeAttempt = {
    _id: attemptId,
    userId,
    status: 'completed',
    insightsStatus: 'completed',
    insightsJson: null,
    appliedToProfileAt: null,
    objectiveSnapshot: null,
    results: new Map(),
  };

  const dapath = require.resolve('../models/DiagnosticAttempt');
  require.cache[dapath] = {
    exports: function FakeDA() {},
    loaded: true, id: dapath,
  };
  require.cache[dapath].exports.findById = async () => fakeAttempt;

  delete require.cache[require.resolve('../controllers/diagnosticController')];
  const ctrl = require('../controllers/diagnosticController');

  const req = { params: { attemptId: String(attemptId) }, user: { id: String(new mongoose.Types.ObjectId()) } };
  let captured;
  let statusCode;
  const res = {
    status: function (c) { statusCode = c; return this; },
    json: function (b) { captured = b; return this; },
  };
  await ctrl.getResults(req, res);
  assert.strictEqual(statusCode, 403);
  assert.strictEqual(captured.error, 'forbidden');
});
