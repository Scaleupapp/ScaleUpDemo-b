const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

function setupStubs({ existingProfile = null } = {}) {
  const dapath = require.resolve('../models/DiagnosticAttempt');
  let saved = null;
  require.cache[dapath] = {
    exports: function FakeDA(data) {
      Object.assign(this, data);
      this.save = async () => { saved = this; this._id = new mongoose.Types.ObjectId(); return this; };
    },
    loaded: true, id: dapath,
  };
  // Helpers attached to the constructor
  require.cache[dapath].exports.findOne = async () => null;

  const kppath = require.resolve('../models/KnowledgeProfile');
  require.cache[kppath] = {
    exports: { findOne: async () => existingProfile },
    loaded: true, id: kppath,
  };

  const objpath = require.resolve('../models/UserObjective');
  require.cache[objpath] = {
    exports: { findOne: () => ({ lean: async () => ({
      _id: 'obj1',
      objectiveType: 'interview_preparation',
      analysis: { competencies: [
        { name: 'system design' }, { name: 'sql' }, { name: 'roadmapping' },
      ] },
    }) }) },
    loaded: true, id: objpath,
  };

  // Stub pool service so diagnosticService loads without OPENAI_API_KEY
  const poolPath = require.resolve('./diagnosticPoolService');
  require.cache[poolPath] = {
    exports: {
      assemblePool: async () => [],
      _internal: { calculatePoolAllocation: () => [] },
    },
    loaded: true, id: poolPath,
  };

  delete require.cache[require.resolve('./diagnosticService')];
  const svc = require('./diagnosticService');
  return { svc, getSaved: () => saved };
}

test('startAttempt creates a new_user attempt with linked competencies', async () => {
  const { svc, getSaved } = setupStubs();
  const userId = new mongoose.Types.ObjectId();
  const result = await svc.startAttempt(userId);
  const saved = getSaved();
  assert.ok(saved);
  assert.strictEqual(saved.flowType, 'new_user');
  assert.strictEqual(saved.status, 'in_progress');
  assert.deepStrictEqual(result.competenciesToAssess.map(c => c.name).sort(), ['roadmapping', 'sql', 'system design']);
});

test('startAttempt creates an existing_user_tune attempt when KnowledgeProfile has activity', async () => {
  const { svc } = setupStubs({
    existingProfile: { totalQuizzesTaken: 5, topicMastery: [
      { topic: 'sql', score: 80, quizzesTaken: 5, scoreHistory: [
        { score: 78 }, { score: 82 }, { score: 80 }, { score: 79 }, { score: 81 },
      ] },
    ] },
  });
  const userId = new mongoose.Types.ObjectId();
  const result = await svc.startAttempt(userId);
  assert.strictEqual(result.flowType, 'existing_user_tune');
});

test('startAttempt returns null when objective has no competencies (caller falls back)', async () => {
  const objpath = require.resolve('../models/UserObjective');
  require.cache[objpath] = {
    exports: { findOne: () => ({ lean: async () => ({ _id: 'obj1', analysis: { competencies: [] } }) }) },
    loaded: true, id: objpath,
  };
  delete require.cache[require.resolve('./diagnosticService')];
  const svc = require('./diagnosticService');
  const result = await svc.startAttempt(new mongoose.Types.ObjectId());
  assert.strictEqual(result, null);
});

test('submitSelfRating stores ratings on the attempt', async () => {
  const dapath = require.resolve('../models/DiagnosticAttempt');
  let savedAttempt = null;
  const fakeAttempt = {
    _id: new mongoose.Types.ObjectId(),
    selfRatings: new Map(),
    poolQuestionIds: [],
    save: async function () { savedAttempt = this; return this; },
  };
  require.cache[dapath] = {
    exports: { findById: async () => fakeAttempt },
    loaded: true, id: dapath,
  };
  // Stub pool service to return a small pool
  const poolPath = require.resolve('./diagnosticPoolService');
  require.cache[poolPath] = {
    exports: {
      assemblePool: async () => [{ _id: 'q1' }, { _id: 'q2' }],
      _internal: {
        calculatePoolAllocation: () => [{ name: 'sql', easy: 1, medium: 1, hard: 0 }],
      },
    },
    loaded: true, id: poolPath,
  };

  delete require.cache[require.resolve('./diagnosticService')];
  const svc = require('./diagnosticService');
  await svc.submitSelfRating(fakeAttempt._id, { sql: 'familiar' });
  assert.strictEqual(savedAttempt.selfRatings.get('sql'), 'familiar');
  assert.strictEqual(savedAttempt.poolQuestionIds.length, 2);
});

test('nextQuestion returns done:true when all competencies converged', async () => {
  const dapath = require.resolve('../models/DiagnosticAttempt');
  const attempt = {
    _id: new mongoose.Types.ObjectId(),
    selfRatings: new Map([['sql', 'novice']]),
    answers: [
      { competency: 'sql', difficulty: 'easy', isCorrect: true, timeTaken: 5 },
      { competency: 'sql', difficulty: 'easy', isCorrect: true, timeTaken: 5 },
    ],
    poolQuestionIds: ['q1', 'q2', 'q3'],
    save: async () => {},
  };
  require.cache[dapath] = {
    exports: { findById: async () => attempt },
    loaded: true, id: dapath,
  };
  const bankPath = require.resolve('../models/DiagnosticQuestionBank');
  require.cache[bankPath] = {
    exports: { findById: async (id) => ({ _id: id, difficulty: 'easy' }) },
    loaded: true, id: bankPath,
  };
  delete require.cache[require.resolve('./diagnosticService')];
  const svc = require('./diagnosticService');
  const result = await svc.nextQuestion(attempt._id);
  assert.strictEqual(result.done, true);
});

test('nextQuestion picks an unused pool question of the right difficulty', async () => {
  const dapath = require.resolve('../models/DiagnosticAttempt');
  const attempt = {
    _id: new mongoose.Types.ObjectId(),
    selfRatings: new Map([['sql', 'familiar']]),
    answers: [],
    poolQuestionIds: ['q-easy', 'q-medium', 'q-hard'],
    save: async () => {},
  };
  require.cache[dapath] = {
    exports: { findById: async () => attempt },
    loaded: true, id: dapath,
  };
  const bankPath = require.resolve('../models/DiagnosticQuestionBank');
  require.cache[bankPath] = {
    exports: {
      findById: async (id) => ({
        _id: id,
        difficulty: id.includes('easy') ? 'easy' : id.includes('medium') ? 'medium' : 'hard',
        questionText: 'q', options: [], correctAnswer: 'A', canonicalCompetency: 'sql',
      }),
    },
    loaded: true, id: bankPath,
  };
  delete require.cache[require.resolve('./diagnosticService')];
  const svc = require('./diagnosticService');
  const result = await svc.nextQuestion(attempt._id);
  assert.ok(result.question);
  // First question for familiar should be easy or medium
  assert.match(result.question.difficulty, /^(easy|medium)$/);
});

test('submitAnswer marks correctness and stores the answer', async () => {
  const dapath = require.resolve('../models/DiagnosticAttempt');
  let saved = null;
  const attempt = {
    _id: new mongoose.Types.ObjectId(),
    answers: [],
    save: async function () { saved = this; },
  };
  require.cache[dapath] = {
    exports: { findById: async () => attempt },
    loaded: true, id: dapath,
  };
  const bankPath = require.resolve('../models/DiagnosticQuestionBank');
  require.cache[bankPath] = {
    exports: {
      findById: async (id) => ({
        _id: id, canonicalCompetency: 'sql', difficulty: 'medium',
        correctAnswer: 'B',
      }),
    },
    loaded: true, id: bankPath,
  };
  delete require.cache[require.resolve('./diagnosticService')];
  const svc = require('./diagnosticService');
  await svc.submitAnswer(attempt._id, 'q1', 'B', 12);
  assert.ok(saved);
  assert.strictEqual(saved.answers[0].isCorrect, true);
  assert.strictEqual(saved.answers[0].selectedAnswer, 'B');
  assert.strictEqual(saved.answers[0].competency, 'sql');
});

test('finishAttempt computes per-competency results and updates attempt status', async () => {
  const dapath = require.resolve('../models/DiagnosticAttempt');
  const attemptId = new mongoose.Types.ObjectId();
  let saved = null;
  const attempt = {
    _id: attemptId, status: 'in_progress',
    userId: new mongoose.Types.ObjectId(),
    selfRatings: new Map([['sql', 'familiar']]),
    answers: [
      { competency: 'sql', difficulty: 'medium', isCorrect: true, timeTaken: 10 },
      { competency: 'sql', difficulty: 'medium', isCorrect: true, timeTaken: 10 },
    ],
    results: new Map(),
    save: async function () { saved = this; },
  };
  require.cache[dapath] = {
    exports: { findById: async () => attempt },
    loaded: true, id: dapath,
  };
  const kpPath = require.resolve('../models/KnowledgeProfile');
  let kpSave = null;
  const kp = {
    userId: attempt.userId, topicMastery: [],
    save: async function () { kpSave = this; },
  };
  require.cache[kpPath] = {
    exports: { findOne: async () => kp },
    loaded: true, id: kpPath,
  };
  const cmPath = require.resolve('../models/ConceptMastery');
  require.cache[cmPath] = {
    exports: { findOneAndUpdate: async () => null },
    loaded: true, id: cmPath,
  };
  delete require.cache[require.resolve('./diagnosticService')];
  const svc = require('./diagnosticService');
  const result = await svc.finishAttempt(attemptId);

  assert.strictEqual(saved.status, 'completed');
  assert.ok(saved.completedAt);
  assert.strictEqual(saved.results.get('sql').assessedBand, 'proficient');
  assert.strictEqual(kpSave.topicMastery[0].topic, 'sql');
  assert.strictEqual(kpSave.topicMastery[0].selfRating, 'familiar');
  // calibrationDelta: familiar→1, proficient→2, delta = 1 (under-rated by 1 band)
  assert.strictEqual(kpSave.topicMastery[0].calibrationAtBaseline.delta, -1); // self < assessed
  assert.ok(result.results.sql);
});

test('abandon at <30% completion drops the data', async () => {
  const dapath = require.resolve('../models/DiagnosticAttempt');
  let saved = null;
  const attempt = {
    _id: new mongoose.Types.ObjectId(),
    selfRatings: new Map([['sql', 'novice'], ['design', 'novice']]),
    answers: [{ competency: 'sql', isCorrect: true }], // 1/8 ≈ 12.5%
    poolQuestionIds: new Array(8).fill(0),
    save: async function () { saved = this; },
  };
  require.cache[dapath] = {
    exports: { findById: async () => attempt },
    loaded: true, id: dapath,
  };
  delete require.cache[require.resolve('./diagnosticService')];
  const svc = require('./diagnosticService');
  await svc.abandon(attempt._id);
  assert.strictEqual(saved.status, 'abandoned');
  assert.strictEqual(saved.abandonStrategy, 'dropped');
});

test('finishAttempt triggers plan regeneration with diagnosticData', async () => {
  const dapath = require.resolve('../models/DiagnosticAttempt');
  const attempt = {
    _id: new mongoose.Types.ObjectId(),
    userId: new mongoose.Types.ObjectId(),
    status: 'in_progress',
    selfRatings: new Map([['sql', 'novice']]),
    answers: [{ competency: 'sql', difficulty: 'easy', isCorrect: true }, { competency: 'sql', difficulty: 'easy', isCorrect: true }],
    results: new Map(),
    save: async () => {},
  };
  require.cache[dapath] = {
    exports: { findById: async () => attempt },
    loaded: true, id: dapath,
  };
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
  let planCalled = null;
  const planPath = require.resolve('./journeyGenerationService');
  require.cache[planPath] = {
    exports: { regenerateForUser: async (uid, opts) => { planCalled = { uid, opts }; } },
    loaded: true, id: planPath,
  };
  delete require.cache[require.resolve('./diagnosticService')];
  const svc = require('./diagnosticService');
  await svc.finishAttempt(attempt._id);
  assert.ok(planCalled, 'plan regeneration should have been triggered');
  assert.ok(planCalled.opts?.diagnosticData?.sql);
});

test('getSynthesis returns userContextService output formatted for E1', async () => {
  const ucsPath = require.resolve('./userContextService');
  require.cache[ucsPath] = {
    exports: {
      getUserContext: async () => ({
        weakTopics: [{ topic: 'system design', score: 42 }],
        strongTopics: [{ topic: 'stats', score: 78 }],
        misconceptions: [{ tag: 'reverses_conditional', count: 6, topics: ['bayes','medical'], explanation: 'Confuses P(A|B) with P(B|A).' }],
        cognitiveTraits: [{ kind: 'time_of_day', bestHourBlock: 'evening', lift: 14 }],
        objective: { label: 'Senior PM', daysToTarget: 38 },
        profile: { totalQuizzesTaken: 47, totalTopicsCovered: 8 },
      }),
      summarize: () => 'mock summary',
    },
    loaded: true, id: ucsPath,
  };
  delete require.cache[require.resolve('./diagnosticService')];
  const svc = require('./diagnosticService');
  const out = await svc.getSynthesis(new (require('mongoose')).Types.ObjectId());
  assert.ok(out.weakest);
  assert.strictEqual(out.weakest[0].topic, 'system design');
  assert.ok(out.strongest);
  assert.ok(out.recurringConfusion);
  assert.ok(out.cognitive);
});

test('existing-user flow: strong competency gets 0 questions', async () => {
  const { _internal } = require('./diagnosticService');
  const profile = {
    totalQuizzesTaken: 10,
    topicMastery: [
      { topic: 'sql', score: 80, quizzesTaken: 6, scoreHistory: Array.from({length: 6}, () => ({ score: 80 })) },
    ],
  };
  const cap = _internal.questionCapForCompetency(profile, 'sql');
  assert.strictEqual(cap, 0);
});

test('existing-user flow: medium-signal competency gets 1 question', async () => {
  const { _internal } = require('./diagnosticService');
  const profile = {
    totalQuizzesTaken: 5,
    topicMastery: [
      { topic: 'sql', score: 70, quizzesTaken: 3, scoreHistory: [{ score: 60 }, { score: 80 }, { score: 70 }] },
    ],
  };
  const cap = _internal.questionCapForCompetency(profile, 'sql');
  assert.strictEqual(cap, 1);
});

test('existing-user flow: weak-signal competency gets full 2-3 questions', async () => {
  const { _internal } = require('./diagnosticService');
  const profile = {
    totalQuizzesTaken: 1,
    topicMastery: [{ topic: 'sql', score: 50, quizzesTaken: 1, scoreHistory: [{ score: 50 }] }],
  };
  const cap = _internal.questionCapForCompetency(profile, 'sql');
  assert.ok(cap >= 2 && cap <= 3);
});

test('existing-user flow: never-touched competency gets full 2-3', async () => {
  const { _internal } = require('./diagnosticService');
  const profile = { totalQuizzesTaken: 0, topicMastery: [] };
  const cap = _internal.questionCapForCompetency(profile, 'sql');
  assert.ok(cap >= 2 && cap <= 3);
});

test('abandon at 70%+ auto-processes the partial set as completed', async () => {
  const dapath = require.resolve('../models/DiagnosticAttempt');
  let saved = null;
  const attempt = {
    _id: new mongoose.Types.ObjectId(),
    userId: new mongoose.Types.ObjectId(),
    selfRatings: new Map([['sql', 'familiar']]),
    answers: [
      { competency: 'sql', difficulty: 'medium', isCorrect: true, timeTaken: 10 },
      { competency: 'sql', difficulty: 'medium', isCorrect: true, timeTaken: 10 },
    ],
    results: new Map(),
    poolQuestionIds: ['q1', 'q2'], // 2/2 = 100%
    save: async function () { saved = this; },
  };
  require.cache[dapath] = {
    exports: { findById: async () => attempt },
    loaded: true, id: dapath,
  };
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
  delete require.cache[require.resolve('./diagnosticService')];
  const svc = require('./diagnosticService');
  await svc.abandon(attempt._id);
  // 70%+ → process as if completed
  assert.strictEqual(saved.status, 'completed');
});

test('startAttempt rejects retake within 30 days of a completed attempt', async () => {
  const dapath = require.resolve('../models/DiagnosticAttempt');
  const recentCompleted = {
    completedAt: new Date(Date.now() - 5 * 86400000), // 5 days ago
    objectiveSnapshot: { _id: 'obj1' },
  };
  require.cache[dapath] = {
    exports: function () {},
    loaded: true, id: dapath,
  };
  require.cache[dapath].exports.findOne = async () => recentCompleted;
  const objpath = require.resolve('../models/UserObjective');
  require.cache[objpath] = {
    exports: { findOne: () => ({ lean: async () => ({ _id: 'obj1', analysis: { competencies: [{ name: 'sql' }] } }) }) },
    loaded: true, id: objpath,
  };
  const kpPath = require.resolve('../models/KnowledgeProfile');
  require.cache[kpPath] = {
    exports: { findOne: async () => null },
    loaded: true, id: kpPath,
  };
  delete require.cache[require.resolve('./diagnosticService')];
  const svc = require('./diagnosticService');
  const result = await svc.startAttempt(new (require('mongoose')).Types.ObjectId());
  assert.strictEqual(result, null);
});

test('startAttempt allows retake within 30d if objective changed', async () => {
  const dapath = require.resolve('../models/DiagnosticAttempt');
  const recentCompleted = {
    completedAt: new Date(Date.now() - 5 * 86400000),
    objectiveSnapshot: { _id: 'old-obj' },
  };
  let savedAttempt = null;
  require.cache[dapath] = {
    exports: function FakeDA(data) {
      Object.assign(this, data);
      this.save = async () => { savedAttempt = this; this._id = 'new'; return this; };
    },
    loaded: true, id: dapath,
  };
  require.cache[dapath].exports.findOne = async () => recentCompleted;
  const objpath = require.resolve('../models/UserObjective');
  require.cache[objpath] = {
    exports: { findOne: () => ({ lean: async () => ({ _id: 'new-obj', analysis: { competencies: [{ name: 'sql' }] } }) }) },
    loaded: true, id: objpath,
  };
  const kpPath = require.resolve('../models/KnowledgeProfile');
  require.cache[kpPath] = {
    exports: { findOne: async () => null },
    loaded: true, id: kpPath,
  };
  delete require.cache[require.resolve('./diagnosticService')];
  const svc = require('./diagnosticService');
  const result = await svc.startAttempt(new (require('mongoose')).Types.ObjectId());
  assert.ok(result);
  assert.strictEqual(savedAttempt.objectiveSnapshot._id, 'new-obj');
});
