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
  require.cache[dapath].exports.updateMany = async () => ({ modifiedCount: 0 });

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

test('startAttempt: 4 prior quizzes is below threshold → new_user flow', async () => {
  const { svc } = setupStubs({
    existingProfile: { totalQuizzesTaken: 4, topicMastery: [] },
  });
  const result = await svc.startAttempt(new mongoose.Types.ObjectId());
  assert.strictEqual(result.flowType, 'new_user');
});

test('startAttempt: 5 prior quizzes is at threshold → existing_user_tune flow', async () => {
  const { svc } = setupStubs({
    existingProfile: { totalQuizzesTaken: 5, topicMastery: [
      { topic: 'sql', score: 80, quizzesTaken: 5, scoreHistory: Array.from({length: 5}, () => ({ score: 80 })) },
    ] },
  });
  const result = await svc.startAttempt(new mongoose.Types.ObjectId());
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
    exports: {
      find: (query) => ({ lean: async () => ['q1', 'q2', 'q3'].map(id => ({ _id: id, difficulty: 'easy', canonicalCompetency: 'sql' })) }),
      findById: async (id) => ({ _id: id, difficulty: 'easy' }),
      updateOne: async () => {},
    },
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
  const fakeDocs = [
    { _id: 'q-easy',   difficulty: 'easy',   questionText: 'q', options: [], correctAnswer: 'A', canonicalCompetency: 'sql' },
    { _id: 'q-medium', difficulty: 'medium', questionText: 'q', options: [], correctAnswer: 'A', canonicalCompetency: 'sql' },
    { _id: 'q-hard',   difficulty: 'hard',   questionText: 'q', options: [], correctAnswer: 'A', canonicalCompetency: 'sql' },
  ];
  require.cache[bankPath] = {
    exports: {
      find: (query) => ({ lean: async () => fakeDocs }),
      findById: async (id) => fakeDocs.find(d => d._id === id) || null,
      updateOne: async () => {},
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
  assert.ok(Array.isArray(result.results), 'results should be an array');
  const sqlResult = result.results.find(r => r.competency === 'sql');
  assert.ok(sqlResult, 'sql result should exist');
  assert.strictEqual(sqlResult.band, 'proficient');
  assert.strictEqual(typeof result.attemptId, 'string');
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
  // Ensure DiagnosticAttempt.findOne is available for getSynthesis's last-attempt query
  const dapath = require.resolve('../models/DiagnosticAttempt');
  require.cache[dapath] = {
    exports: function FakeDA() {},
    loaded: true, id: dapath,
  };
  require.cache[dapath].exports.findOne = async () => null;
  delete require.cache[require.resolve('./diagnosticService')];
  const svc = require('./diagnosticService');
  const out = await svc.getSynthesis(new (require('mongoose')).Types.ObjectId());
  assert.ok(out.weakest);
  assert.strictEqual(out.weakest[0].topic, 'system design');
  assert.ok(out.strongest);
  assert.ok(out.recurringConfusion);
  assert.ok(out.cognitive);
  // lastDiagnostic should be null when no completed attempt exists
  assert.strictEqual(out.lastDiagnostic, null);
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
  const objpath = require.resolve('../models/UserObjective');
  const kpPath = require.resolve('../models/KnowledgeProfile');
  const svcPath = require.resolve('./diagnosticService');
  const orig = {
    da: require.cache[dapath],
    obj: require.cache[objpath],
    kp: require.cache[kpPath],
    svc: require.cache[svcPath],
  };
  try {
    const recentCompleted = {
      completedAt: new Date(Date.now() - 5 * 86400000), // 5 days ago
      objectiveSnapshot: { _id: 'obj1' },
    };
    require.cache[dapath] = {
      exports: function () {},
      loaded: true, id: dapath,
    };
    require.cache[dapath].exports.findOne = async () => recentCompleted;
    require.cache[dapath].exports.updateMany = async () => ({ modifiedCount: 0 });
    require.cache[objpath] = {
      exports: { findOne: () => ({ lean: async () => ({ _id: 'obj1', analysis: { competencies: [{ name: 'sql' }] } }) }) },
      loaded: true, id: objpath,
    };
    require.cache[kpPath] = {
      exports: { findOne: async () => null },
      loaded: true, id: kpPath,
    };
    delete require.cache[svcPath];
    const svc = require(svcPath);
    const result = await svc.startAttempt(new (require('mongoose')).Types.ObjectId());
    assert.strictEqual(result, null);
  } finally {
    if (orig.da) require.cache[dapath] = orig.da; else delete require.cache[dapath];
    if (orig.obj) require.cache[objpath] = orig.obj; else delete require.cache[objpath];
    if (orig.kp) require.cache[kpPath] = orig.kp; else delete require.cache[kpPath];
    if (orig.svc) require.cache[svcPath] = orig.svc; else delete require.cache[svcPath];
  }
});

test('startAttempt allows retake within 30d if objective changed', async () => {
  const dapath = require.resolve('../models/DiagnosticAttempt');
  const objpath = require.resolve('../models/UserObjective');
  const kpPath = require.resolve('../models/KnowledgeProfile');
  const svcPath = require.resolve('./diagnosticService');
  const orig = {
    da: require.cache[dapath],
    obj: require.cache[objpath],
    kp: require.cache[kpPath],
    svc: require.cache[svcPath],
  };
  try {
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
    require.cache[dapath].exports.updateMany = async () => ({ modifiedCount: 0 });
    require.cache[objpath] = {
      exports: { findOne: () => ({ lean: async () => ({ _id: 'new-obj', analysis: { competencies: [{ name: 'sql' }] } }) }) },
      loaded: true, id: objpath,
    };
    require.cache[kpPath] = {
      exports: { findOne: async () => null },
      loaded: true, id: kpPath,
    };
    delete require.cache[svcPath];
    const svc = require(svcPath);
    const result = await svc.startAttempt(new (require('mongoose')).Types.ObjectId());
    assert.ok(result);
    assert.strictEqual(savedAttempt.objectiveSnapshot._id, 'new-obj');
  } finally {
    if (orig.da) require.cache[dapath] = orig.da; else delete require.cache[dapath];
    if (orig.obj) require.cache[objpath] = orig.obj; else delete require.cache[objpath];
    if (orig.kp) require.cache[kpPath] = orig.kp; else delete require.cache[kpPath];
    if (orig.svc) require.cache[svcPath] = orig.svc; else delete require.cache[svcPath];
  }
});

test('startAttempt abandons prior in_progress attempts of the same user', async () => {
  const dapath = require.resolve('../models/DiagnosticAttempt');
  const objpath = require.resolve('../models/UserObjective');
  const kpPath = require.resolve('../models/KnowledgeProfile');
  const svcPath = require.resolve('./diagnosticService');
  const orig = {
    da: require.cache[dapath], obj: require.cache[objpath],
    kp: require.cache[kpPath], svc: require.cache[svcPath],
  };
  try {
    let updateManyArgs = null;
    require.cache[dapath] = {
      exports: function FakeDA(data) {
        Object.assign(this, data);
        this.save = async () => { this._id = 'new'; return this; };
      },
      loaded: true, id: dapath,
    };
    require.cache[dapath].exports.findOne = async () => null; // no prior completed
    require.cache[dapath].exports.updateMany = async (filter, update) => {
      updateManyArgs = { filter, update };
      return { modifiedCount: 1 };
    };
    require.cache[objpath] = {
      exports: { findOne: () => ({ lean: async () => ({ _id: 'obj1', analysis: { competencies: [{ name: 'sql' }] } }) }) },
      loaded: true, id: objpath,
    };
    require.cache[kpPath] = { exports: { findOne: async () => null }, loaded: true, id: kpPath };
    delete require.cache[svcPath];
    const svc = require(svcPath);
    const result = await svc.startAttempt(new (require('mongoose')).Types.ObjectId());
    assert.ok(result);
    assert.ok(updateManyArgs, 'updateMany should have been called');
    assert.deepStrictEqual(updateManyArgs.filter.status, { $in: ['in_progress'] });
    assert.strictEqual(updateManyArgs.update.$set.status, 'abandoned');
  } finally {
    if (orig.da) require.cache[dapath] = orig.da; else delete require.cache[dapath];
    if (orig.obj) require.cache[objpath] = orig.obj; else delete require.cache[objpath];
    if (orig.kp) require.cache[kpPath] = orig.kp; else delete require.cache[kpPath];
    if (orig.svc) require.cache[svcPath] = orig.svc; else delete require.cache[svcPath];
  }
});

test('startAttempt does not block when prior attempt has null objectiveSnapshot', async () => {
  const dapath = require.resolve('../models/DiagnosticAttempt');
  const objpath = require.resolve('../models/UserObjective');
  const kpPath = require.resolve('../models/KnowledgeProfile');
  const svcPath = require.resolve('./diagnosticService');
  const orig = {
    da: require.cache[dapath], obj: require.cache[objpath],
    kp: require.cache[kpPath], svc: require.cache[svcPath],
  };
  try {
    require.cache[dapath] = {
      exports: function FakeDA(data) {
        Object.assign(this, data);
        this.save = async () => { this._id = 'new'; return this; };
      },
      loaded: true, id: dapath,
    };
    require.cache[dapath].exports.findOne = async () => ({
      completedAt: new Date(Date.now() - 5 * 86400000),
      objectiveSnapshot: null, // legacy attempt without snapshot
    });
    require.cache[dapath].exports.updateMany = async () => ({ modifiedCount: 0 });
    require.cache[objpath] = {
      exports: { findOne: () => ({ lean: async () => ({ _id: 'obj1', analysis: { competencies: [{ name: 'sql' }] } }) }) },
      loaded: true, id: objpath,
    };
    require.cache[kpPath] = { exports: { findOne: async () => null }, loaded: true, id: kpPath };
    delete require.cache[svcPath];
    const svc = require(svcPath);
    const result = await svc.startAttempt(new (require('mongoose')).Types.ObjectId());
    assert.ok(result, 'should not block when prior snapshot is null');
  } finally {
    if (orig.da) require.cache[dapath] = orig.da; else delete require.cache[dapath];
    if (orig.obj) require.cache[objpath] = orig.obj; else delete require.cache[objpath];
    if (orig.kp) require.cache[kpPath] = orig.kp; else delete require.cache[kpPath];
    if (orig.svc) require.cache[svcPath] = orig.svc; else delete require.cache[svcPath];
  }
});

test('finishAttempt sets confidence:low when avg time per answer < 5s', async () => {
  const dapath = require.resolve('../models/DiagnosticAttempt');
  const kpPath = require.resolve('../models/KnowledgeProfile');
  const cmPath = require.resolve('../models/ConceptMastery');
  const svcPath = require.resolve('./diagnosticService');
  const orig = {
    da: require.cache[dapath], kp: require.cache[kpPath],
    cm: require.cache[cmPath], svc: require.cache[svcPath],
  };
  try {
    let saved = null;
    const attempt = {
      _id: new (require('mongoose')).Types.ObjectId(),
      userId: new (require('mongoose')).Types.ObjectId(),
      status: 'in_progress',
      selfRatings: new Map([['sql', 'novice']]),
      answers: [
        { competency: 'sql', difficulty: 'easy', isCorrect: true, timeTaken: 3 },
        { competency: 'sql', difficulty: 'easy', isCorrect: true, timeTaken: 4 },
      ],
      results: new Map(),
      save: async function () { saved = this; },
    };
    require.cache[dapath] = {
      exports: { findById: async () => attempt },
      loaded: true, id: dapath,
    };
    require.cache[kpPath] = {
      exports: { findOne: async () => null, findOneAndUpdate: async () => null },
      loaded: true, id: kpPath,
    };
    require.cache[cmPath] = {
      exports: { findOneAndUpdate: async () => null },
      loaded: true, id: cmPath,
    };
    delete require.cache[svcPath];
    const svc = require(svcPath);
    await svc.finishAttempt(attempt._id);
    assert.strictEqual(saved.confidence, 'low');
  } finally {
    if (orig.da) require.cache[dapath] = orig.da; else delete require.cache[dapath];
    if (orig.kp) require.cache[kpPath] = orig.kp; else delete require.cache[kpPath];
    if (orig.cm) require.cache[cmPath] = orig.cm; else delete require.cache[cmPath];
    if (orig.svc) require.cache[svcPath] = orig.svc; else delete require.cache[svcPath];
  }
});

test('finishAttempt sets confidence:medium when avg time 5-12s', async () => {
  const dapath = require.resolve('../models/DiagnosticAttempt');
  const kpPath = require.resolve('../models/KnowledgeProfile');
  const cmPath = require.resolve('../models/ConceptMastery');
  const svcPath = require.resolve('./diagnosticService');
  const orig = {
    da: require.cache[dapath], kp: require.cache[kpPath],
    cm: require.cache[cmPath], svc: require.cache[svcPath],
  };
  try {
    let saved = null;
    const attempt = {
      _id: new (require('mongoose')).Types.ObjectId(),
      userId: new (require('mongoose')).Types.ObjectId(),
      status: 'in_progress',
      selfRatings: new Map([['sql', 'novice']]),
      answers: [
        { competency: 'sql', difficulty: 'easy', isCorrect: true, timeTaken: 8 },
        { competency: 'sql', difficulty: 'easy', isCorrect: true, timeTaken: 10 },
      ],
      results: new Map(),
      save: async function () { saved = this; },
    };
    require.cache[dapath] = { exports: { findById: async () => attempt }, loaded: true, id: dapath };
    require.cache[kpPath] = { exports: { findOne: async () => null, findOneAndUpdate: async () => null }, loaded: true, id: kpPath };
    require.cache[cmPath] = { exports: { findOneAndUpdate: async () => null }, loaded: true, id: cmPath };
    delete require.cache[svcPath];
    const svc = require(svcPath);
    await svc.finishAttempt(attempt._id);
    assert.strictEqual(saved.confidence, 'medium');
  } finally {
    if (orig.da) require.cache[dapath] = orig.da; else delete require.cache[dapath];
    if (orig.kp) require.cache[kpPath] = orig.kp; else delete require.cache[kpPath];
    if (orig.cm) require.cache[cmPath] = orig.cm; else delete require.cache[cmPath];
    if (orig.svc) require.cache[svcPath] = orig.svc; else delete require.cache[svcPath];
  }
});

test('startAttempt persists objectiveSnapshot.label from objective.specifics.examName', async () => {
  const dapath = require.resolve('../models/DiagnosticAttempt');
  const objpath = require.resolve('../models/UserObjective');
  const kpPath = require.resolve('../models/KnowledgeProfile');
  const svcPath = require.resolve('./diagnosticService');
  const orig = {
    da: require.cache[dapath],
    obj: require.cache[objpath],
    kp: require.cache[kpPath],
    svc: require.cache[svcPath],
  };
  try {
    let savedAttempt = null;
    require.cache[dapath] = {
      exports: function FakeDA(data) {
        Object.assign(this, data);
        this.save = async () => { savedAttempt = this; this._id = new mongoose.Types.ObjectId(); return this; };
      },
      loaded: true, id: dapath,
    };
    require.cache[dapath].exports.findOne = async () => null;
    require.cache[dapath].exports.updateMany = async () => ({ modifiedCount: 0 });
    require.cache[objpath] = {
      exports: {
        findOne: () => ({
          lean: async () => ({
            _id: 'exam-obj',
            objectiveType: 'exam_preparation',
            specifics: { examName: 'GATE 2026' },
            analysis: { competencies: [{ name: 'sql' }] },
          }),
        }),
      },
      loaded: true, id: objpath,
    };
    require.cache[kpPath] = { exports: { findOne: async () => null }, loaded: true, id: kpPath };
    delete require.cache[svcPath];
    const svc = require(svcPath);
    await svc.startAttempt(new mongoose.Types.ObjectId());
    assert.ok(savedAttempt, 'attempt should have been saved');
    assert.strictEqual(savedAttempt.objectiveSnapshot.label, 'GATE 2026');
  } finally {
    if (orig.da) require.cache[dapath] = orig.da; else delete require.cache[dapath];
    if (orig.obj) require.cache[objpath] = orig.obj; else delete require.cache[objpath];
    if (orig.kp) require.cache[kpPath] = orig.kp; else delete require.cache[kpPath];
    if (orig.svc) require.cache[svcPath] = orig.svc; else delete require.cache[svcPath];
  }
});

// ---------------------------------------------------------------------------
// V2 happy path (Plan 3a Task 8) — feature-flag dispatched orchestration.
// ---------------------------------------------------------------------------
test('V2: startAttempt → nextQuestion → submitAnswer → finishAttempt with canonical names', async () => {
  const userId = new mongoose.Types.ObjectId();
  const attemptId = new mongoose.Types.ObjectId();
  const qId = new mongoose.Types.ObjectId();

  let savedAttempt = null;
  function FakeDA(data) {
    Object.assign(this, data);
    if (!this._id) this._id = attemptId;
    if (data.selfRatings && !(data.selfRatings instanceof Map)) {
      this.selfRatings = new Map(Object.entries(data.selfRatings));
    }
    this.answers = this.answers || [];
    this.results = this.results || new Map();
    this.poolQuestionIds = this.poolQuestionIds || [];
    this.save = async () => { savedAttempt = this; return this; };
  }
  FakeDA.findById = async (id) => savedAttempt && String(savedAttempt._id) === String(id) ? savedAttempt : null;
  FakeDA.findOne = async () => null;
  FakeDA.updateMany = async () => ({ modifiedCount: 0 });

  const FakeUO = {
    findOne(q) {
      const isPrimaryQuery = q && q.isPrimary === true;
      return { lean: async () => isPrimaryQuery ? null : ({
        _id: 'obj-v2',
        objectiveType: 'upskilling',
        topicSelfRatings: new Map([['Product Strategy', 'familiar']]),
        specificsCanonical: { targetSkill: 'Product Management' },
        specifics: { targetSkill: 'Product Management' },
      }) };
    },
    findById: (id) => ({ lean: async () => ({
      _id: id,
      objectiveType: 'upskilling',
      specificsCanonical: { targetSkill: 'Product Management' },
      specifics: { targetSkill: 'Product Management' },
    }) }),
  };

  const FakeKP = { findOne: async () => null };

  const FakeBank = {
    findById: (id) => ({ lean: async () => ({
      _id: id,
      canonicalCompetency: 'product-strategy',
      difficulty: 'medium',
      questionText: 'Q?',
      options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }],
      correctAnswer: 'A',
    }) }),
    updateOne: async () => ({ acknowledged: true }),
    find: () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }),
  };

  const FakeTax = {
    findOne: () => ({ lean: async () => ({
      objectiveType: 'upskilling',
      targetKey: 'upskilling::product-management',
      topics: [{ name: 'Product Strategy', canonicalName: 'product-strategy' }],
    }) }),
  };

  const FakePool = {
    assemblePool: async () => ({
      questions: [{
        _id: qId,
        canonicalCompetency: 'product-strategy',
        difficulty: 'medium',
        questionText: 'What is product strategy?',
        options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }],
        correctAnswer: 'A',
        requiresVoice: false,
      }],
    }),
    _internal: { calculatePoolAllocation: () => [] },
  };

  const dapath2 = require.resolve('../models/DiagnosticAttempt');
  const objpath2 = require.resolve('../models/UserObjective');
  const kppath2 = require.resolve('../models/KnowledgeProfile');
  const bankpath2 = require.resolve('../models/DiagnosticQuestionBank');
  const taxpath2 = require.resolve('../models/TopicTaxonomy');
  const poolpath2 = require.resolve('./diagnosticPoolService');
  const svcpath2 = require.resolve('./diagnosticService');
  const orig2 = {
    da: require.cache[dapath2], obj: require.cache[objpath2], kp: require.cache[kppath2],
    bank: require.cache[bankpath2], tax: require.cache[taxpath2], pool: require.cache[poolpath2],
    svc: require.cache[svcpath2], flag: process.env.FEATURE_DAY1_DIAGNOSTIC_V2,
  };
  process.env.FEATURE_DAY1_DIAGNOSTIC_V2 = 'true';
  require.cache[dapath2]   = { exports: FakeDA, loaded: true, id: dapath2 };
  require.cache[objpath2]  = { exports: FakeUO, loaded: true, id: objpath2 };
  require.cache[kppath2]   = { exports: FakeKP, loaded: true, id: kppath2 };
  require.cache[bankpath2] = { exports: FakeBank, loaded: true, id: bankpath2 };
  require.cache[taxpath2]  = { exports: FakeTax, loaded: true, id: taxpath2 };
  require.cache[poolpath2] = { exports: FakePool, loaded: true, id: poolpath2 };
  delete require.cache[svcpath2];

  try {
    const svc = require(svcpath2);

    const start = await svc.startAttempt(userId);
    assert.ok(start, 'startAttempt should return a result');
    assert.strictEqual(start.flowType, 'new_user');
    assert.ok(start.totalEstimatedQuestions > 0, 'totalEstimatedQuestions should be positive');
    assert.ok(savedAttempt.selfRatings.has('product-strategy'), 'canonical key should be set');

    const next = await svc.nextQuestion(savedAttempt._id);
    assert.strictEqual(next.done, false);
    assert.strictEqual(String(next.question._id), String(qId));
    assert.strictEqual(next.question.canonicalCompetency, 'product-strategy');
    assert.strictEqual(next.question.competency, 'Product Strategy', 'display name from taxonomy');

    const ack = await svc.submitAnswer(savedAttempt._id, qId, 'A', 7);
    assert.strictEqual(ack.ack, true);
    assert.strictEqual(savedAttempt.answers.length, 1);
    assert.strictEqual(savedAttempt.answers[0].competency, 'product-strategy', 'canonical stored on answer');
    assert.strictEqual(savedAttempt.answers[0].isCorrect, true);

    const next2 = await svc.nextQuestion(savedAttempt._id);
    assert.strictEqual(next2.done, true);

    const final = await svc.finishAttempt(savedAttempt._id);
    assert.strictEqual(final.status, 'completed');
    assert.strictEqual(final.results.length, 1);
    assert.strictEqual(final.results[0].canonicalCompetency, 'product-strategy');
    assert.strictEqual(final.results[0].competency, 'Product Strategy', 'display name on result');
    assert.strictEqual(final.results[0].score, 100, '1/1 correct → score 100');
    assert.strictEqual(final.results[0].band, 'expert');
    assert.strictEqual(savedAttempt.planGenerationStatus, 'pending');
  } finally {
    if (orig2.da)   require.cache[dapath2]   = orig2.da;   else delete require.cache[dapath2];
    if (orig2.obj)  require.cache[objpath2]  = orig2.obj;  else delete require.cache[objpath2];
    if (orig2.kp)   require.cache[kppath2]   = orig2.kp;   else delete require.cache[kppath2];
    if (orig2.bank) require.cache[bankpath2] = orig2.bank; else delete require.cache[bankpath2];
    if (orig2.tax)  require.cache[taxpath2]  = orig2.tax;  else delete require.cache[taxpath2];
    if (orig2.pool) require.cache[poolpath2] = orig2.pool; else delete require.cache[poolpath2];
    if (orig2.svc)  require.cache[svcpath2]  = orig2.svc;  else delete require.cache[svcpath2];
    if (orig2.flag === undefined) delete process.env.FEATURE_DAY1_DIAGNOSTIC_V2;
    else process.env.FEATURE_DAY1_DIAGNOSTIC_V2 = orig2.flag;
  }
});

test('V2: feature flag off → V1 path preserved', async () => {
  const origFlag = process.env.FEATURE_DAY1_DIAGNOSTIC_V2;
  delete process.env.FEATURE_DAY1_DIAGNOSTIC_V2;
  try {
    const dapath3 = require.resolve('../models/DiagnosticAttempt');
    const kppath3 = require.resolve('../models/KnowledgeProfile');
    const objpath3 = require.resolve('../models/UserObjective');
    const poolPath3 = require.resolve('./diagnosticPoolService');
    const svcPath3 = require.resolve('./diagnosticService');
    const origCache = {
      da: require.cache[dapath3], kp: require.cache[kppath3], obj: require.cache[objpath3],
      pool: require.cache[poolPath3], svc: require.cache[svcPath3],
    };

    require.cache[dapath3] = {
      exports: function FakeDA(data) {
        Object.assign(this, data);
        this.save = async () => { this._id = new mongoose.Types.ObjectId(); return this; };
      },
      loaded: true, id: dapath3,
    };
    require.cache[dapath3].exports.findOne = async () => null;
    require.cache[dapath3].exports.updateMany = async () => ({ modifiedCount: 0 });
    require.cache[kppath3] = { exports: { findOne: async () => null }, loaded: true, id: kppath3 };
    require.cache[objpath3] = {
      exports: { findOne: () => ({ lean: async () => ({
        _id: 'obj1',
        objectiveType: 'interview_preparation',
        analysis: { competencies: [{ name: 'sql' }] },
      }) }) },
      loaded: true, id: objpath3,
    };
    require.cache[poolPath3] = {
      exports: { assemblePool: async () => [], _internal: { calculatePoolAllocation: () => [] } },
      loaded: true, id: poolPath3,
    };
    delete require.cache[svcPath3];

    try {
      const svc = require('./diagnosticService');
      const result = await svc.startAttempt(new mongoose.Types.ObjectId());
      assert.ok(result, 'V1 path should still produce a result');
      assert.strictEqual(result.flowType, 'new_user');
      assert.strictEqual(result.totalEstimatedQuestions, undefined, 'V2-specific field absent on V1 path');
    } finally {
      if (origCache.da)   require.cache[dapath3]   = origCache.da;   else delete require.cache[dapath3];
      if (origCache.kp)   require.cache[kppath3]   = origCache.kp;   else delete require.cache[kppath3];
      if (origCache.obj)  require.cache[objpath3]  = origCache.obj;  else delete require.cache[objpath3];
      if (origCache.pool) require.cache[poolPath3] = origCache.pool; else delete require.cache[poolPath3];
      if (origCache.svc)  require.cache[svcPath3]  = origCache.svc;  else delete require.cache[svcPath3];
    }
  } finally {
    if (origFlag === undefined) delete process.env.FEATURE_DAY1_DIAGNOSTIC_V2;
    else process.env.FEATURE_DAY1_DIAGNOSTIC_V2 = origFlag;
  }
});
