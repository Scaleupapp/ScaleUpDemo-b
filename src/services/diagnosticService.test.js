const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

// Stub planGenerationQueue at module level so every diagnosticService reload
// gets a no-op queue instead of a live Redis connection.
const queuePath = require.resolve('../config/queue');
require.cache[queuePath] = {
  exports: { planGenerationQueue: { add: async () => ({}) } },
  loaded: true, id: queuePath,
};

// Stub the OpenAI client so diagnosticPoolService loads without OPENAI_API_KEY.
const openaiPath = require.resolve('../config/openai');
require.cache[openaiPath] = {
  exports: { chat: { completions: { create: async () => ({ choices: [] }) } } },
  loaded: true, id: openaiPath,
};

// ---------------------------------------------------------------------------
// Happy path: startAttempt → nextQuestion → submitAnswer → finishAttempt
// with canonical names + display-name resolution from TopicTaxonomy.
// ---------------------------------------------------------------------------
test('startAttempt → nextQuestion → submitAnswer → finishAttempt with canonical names', async () => {
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
  FakeDA.updateOne = async () => ({ modifiedCount: 0 });

  const FakeUO = {
    findOne(q) {
      const isPrimaryQuery = q && q.isPrimary === true;
      return { lean: async () => isPrimaryQuery ? null : ({
        _id: 'obj-canonical',
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
    // assemblePool returns an ARRAY of question docs (see diagnosticService.js
    // submitSelfRating:44 `pool.map(...)` and _ensureAttemptPool:419
    // `(questions||[]).map(...)`), not a wrapper object.
    assemblePool: async () => ([{
      _id: qId,
      canonicalCompetency: 'product-strategy',
      difficulty: 'medium',
      questionText: 'What is product strategy?',
      options: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }],
      correctAnswer: 'A',
      requiresVoice: false,
    }]),
    _internal: { calculatePoolAllocation: () => [] },
  };

  const dapath2    = require.resolve('../models/DiagnosticAttempt');
  const objpath2   = require.resolve('../models/UserObjective');
  const bankpath2  = require.resolve('../models/DiagnosticQuestionBank');
  const taxpath2   = require.resolve('../models/TopicTaxonomy');
  const poolpath2  = require.resolve('./diagnosticPoolService');
  const igspath2   = require.resolve('./diagnostic/insightsGenerationService');
  const svcpath2   = require.resolve('./diagnosticService');
  // finishAttempt best-effort side-effects lazy-require these — stub so the test
  // doesn't hit real mongoose and stall on buffering timeouts.
  const kspath2    = require.resolve('./knowledgeService');
  const userpath2  = require.resolve('../models/User');
  const epspath2   = require.resolve('./institution/enrollmentProgressService');
  const orig2 = {
    da:   require.cache[dapath2],   obj:  require.cache[objpath2],
    bank: require.cache[bankpath2], tax:  require.cache[taxpath2],  pool: require.cache[poolpath2],
    igs:  require.cache[igspath2],  svc:  require.cache[svcpath2],
    ks:   require.cache[kspath2],   user: require.cache[userpath2], eps: require.cache[epspath2],
  };
  require.cache[dapath2]   = { exports: FakeDA, loaded: true, id: dapath2 };
  require.cache[objpath2]  = { exports: FakeUO, loaded: true, id: objpath2 };
  require.cache[bankpath2] = { exports: FakeBank, loaded: true, id: bankpath2 };
  require.cache[taxpath2]  = { exports: FakeTax, loaded: true, id: taxpath2 };
  require.cache[poolpath2] = { exports: FakePool, loaded: true, id: poolpath2 };
  require.cache[kspath2]   = { exports: { updateMastery: async () => ({ profile: null }) }, loaded: true, id: kspath2 };
  require.cache[userpath2] = { exports: { findByIdAndUpdate: async () => ({}), findById: () => ({ select: () => ({ lean: async () => ({ v2OptedIn: false }) }) }) }, loaded: true, id: userpath2 };
  require.cache[epspath2]  = { exports: { markDiagnosticDone: async () => ({}) }, loaded: true, id: epspath2 };
  // Stub insightsGenerationService so finishAttempt doesn't call OpenAI
  require.cache[igspath2]  = {
    exports: {
      generateInsights: async () => ({ source: 'template', insights: { hero: 'test', calibration: 'ok', patterns: ['p'], topicTakeaways: {}, planHeadline: 'plan' } }),
      _templateInsights: () => ({ hero: 'test', calibration: 'ok', patterns: ['p'], topicTakeaways: {}, planHeadline: 'plan' }),
    },
    loaded: true, id: igspath2,
  };
  delete require.cache[svcpath2];

  try {
    const svc = require(svcpath2);

    const start = await svc.startAttempt(userId);
    assert.ok(start, 'startAttempt should return a result');
    assert.strictEqual(start.flowType, 'new_user');
    assert.ok(start.totalEstimatedQuestions > 0, 'totalEstimatedQuestions should be positive');
    assert.strictEqual(savedAttempt.totalEstimatedQuestions, start.totalEstimatedQuestions,
      'planned total must be persisted on the attempt doc (Workstream C)');
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
    assert.ok(final.insightsStatus, 'insightsStatus should be present on result object');
    assert.ok(final.insights, 'insights should be non-null on result object');
    assert.strictEqual(final.results[0].calibrationClass, 'undersells', 'score 100 vs familiar midpoint 42 → undersells');
  } finally {
    if (orig2.da)   require.cache[dapath2]   = orig2.da;   else delete require.cache[dapath2];
    if (orig2.obj)  require.cache[objpath2]  = orig2.obj;  else delete require.cache[objpath2];
    if (orig2.bank) require.cache[bankpath2] = orig2.bank; else delete require.cache[bankpath2];
    if (orig2.tax)  require.cache[taxpath2]  = orig2.tax;  else delete require.cache[taxpath2];
    if (orig2.pool) require.cache[poolpath2] = orig2.pool; else delete require.cache[poolpath2];
    if (orig2.igs)  require.cache[igspath2]  = orig2.igs;  else delete require.cache[igspath2];
    if (orig2.svc)  require.cache[svcpath2]  = orig2.svc;  else delete require.cache[svcpath2];
    if (orig2.ks)   require.cache[kspath2]   = orig2.ks;   else delete require.cache[kspath2];
    if (orig2.user) require.cache[userpath2] = orig2.user; else delete require.cache[userpath2];
    if (orig2.eps)  require.cache[epspath2]  = orig2.eps;  else delete require.cache[epspath2];
  }
});

// ---------------------------------------------------------------------------
// _missedDifficultiesFor smoke tests (pure function, no DB needed)
// ---------------------------------------------------------------------------
test('_missedDifficultiesFor: empty answers → []', () => {
  const { _internal } = require('./diagnosticService');
  const result = _internal._missedDifficultiesFor([], 'foo');
  assert.deepStrictEqual(result, []);
});

test('_missedDifficultiesFor: returns unique missed difficulties for the given competency', () => {
  const { _internal } = require('./diagnosticService');
  const answers = [
    { competency: 'a', isCorrect: false, difficulty: 'hard' },
    { competency: 'a', isCorrect: false, difficulty: 'medium' },
    { competency: 'a', isCorrect: false, difficulty: 'hard' },   // duplicate — deduped
    { competency: 'a', isCorrect: true,  difficulty: 'easy' },   // correct — excluded
    { competency: 'b', isCorrect: false, difficulty: 'easy' },   // different competency — excluded
  ];
  const result = _internal._missedDifficultiesFor(answers, 'a');
  assert.deepStrictEqual(result.slice().sort(), ['hard', 'medium']);
});

// ---------------------------------------------------------------------------
// finishAttempt populates insights fields on template fallback
// ---------------------------------------------------------------------------
test('finishAttempt populates insightsJson/Source/Status/Latency on template fallback', async () => {
  const mongoose2 = require('mongoose');
  const attemptId3b = new mongoose2.Types.ObjectId();
  let savedAttempt3b = null;

  const fakeAttempt3b = {
    _id: attemptId3b,
    status: 'in_progress',
    userId: new mongoose2.Types.ObjectId(),
    selfRatings: new Map([['sql', 'familiar']]),
    answers: [
      { competency: 'sql', difficulty: 'medium', isCorrect: true,  timeTaken: 10 },
      { competency: 'sql', difficulty: 'medium', isCorrect: false, timeTaken: 8 },
    ],
    results: new Map(),
    objectiveSnapshot: null,
    appliedToProfileAt: null,
    insightsStatus: 'pending',
    insightsSource: undefined,
    insightsJson: null,
    insightsLatencyMs: null,
    planGenerationStatus: 'pending',
    save: async function () { savedAttempt3b = this; return this; },
  };

  const dapath3b   = require.resolve('../models/DiagnosticAttempt');
  const taxpath3b  = require.resolve('../models/TopicTaxonomy');
  const objpath3b  = require.resolve('../models/UserObjective');
  const igspath3b  = require.resolve('./diagnostic/insightsGenerationService');
  const calpath3b  = require.resolve('../utils/calibration');
  const svcpath3b  = require.resolve('./diagnosticService');
  // finishAttempt best-effort side-effects (knowledge seed, user flag, enrollment
  // advance) lazy-require these. Stub them so the test doesn't hit real mongoose
  // and stall on buffering timeouts — behaviour under test (insights) is unchanged.
  const kspath3b   = require.resolve('./knowledgeService');
  const userpath3b = require.resolve('../models/User');
  const epspath3b  = require.resolve('./institution/enrollmentProgressService');

  const orig3b = {
    da:  require.cache[dapath3b],
    tax: require.cache[taxpath3b],
    obj: require.cache[objpath3b],
    igs: require.cache[igspath3b],
    svc: require.cache[svcpath3b],
    ks:  require.cache[kspath3b],
    user: require.cache[userpath3b],
    eps: require.cache[epspath3b],
  };

  require.cache[dapath3b]  = { exports: { findById: async () => fakeAttempt3b, updateOne: async () => ({ modifiedCount: 0 }) }, loaded: true, id: dapath3b };
  require.cache[taxpath3b] = { exports: { findOne: () => ({ lean: async () => null }) }, loaded: true, id: taxpath3b };
  require.cache[objpath3b] = { exports: { findById: () => ({ lean: async () => null }) }, loaded: true, id: objpath3b };
  require.cache[kspath3b]  = { exports: { updateMastery: async () => ({ profile: null }) }, loaded: true, id: kspath3b };
  require.cache[userpath3b] = { exports: { findByIdAndUpdate: async () => ({}), findById: () => ({ select: () => ({ lean: async () => ({ v2OptedIn: false }) }) }) }, loaded: true, id: userpath3b };
  require.cache[epspath3b] = { exports: { markDiagnosticDone: async () => ({}) }, loaded: true, id: epspath3b };
  // Stub insightsGenerationService: generateInsights throws → hard-failure path exercises template branch in service
  const templateOut = { hero: 'h', calibration: 'c', patterns: ['p'], topicTakeaways: { sql: 'do it' }, planHeadline: 'plan for you here' };
  require.cache[igspath3b] = {
    exports: {
      generateInsights: async () => { throw new Error('forced-error'); },
      _templateInsights: () => templateOut,
    },
    loaded: true, id: igspath3b,
  };
  delete require.cache[svcpath3b];

  try {
    const svc3b = require(svcpath3b);
    const final3b = await svc3b.finishAttempt(attemptId3b);

    // Result object shape
    assert.strictEqual(final3b.status, 'completed');
    assert.ok(final3b.insights !== null, 'insights should be non-null on fallback');
    assert.strictEqual(final3b.insightsStatus, 'fallback');

    // Persisted fields on the attempt
    assert.ok(savedAttempt3b.insightsJson !== null, 'insightsJson should be persisted');
    assert.strictEqual(savedAttempt3b.insightsSource, 'template');
    assert.strictEqual(savedAttempt3b.insightsStatus, 'fallback');
    assert.strictEqual(typeof savedAttempt3b.insightsLatencyMs, 'number');

    // calibrationClass present on every result entry
    const VALID_CLASSES = ['well-calibrated', 'overestimates', 'undersells'];
    for (const [, r] of savedAttempt3b.results.entries()) {
      assert.ok(VALID_CLASSES.includes(r.calibrationClass), `calibrationClass '${r.calibrationClass}' must be one of the three enum values`);
    }
  } finally {
    if (orig3b.da)  require.cache[dapath3b]  = orig3b.da;  else delete require.cache[dapath3b];
    if (orig3b.tax) require.cache[taxpath3b] = orig3b.tax; else delete require.cache[taxpath3b];
    if (orig3b.obj) require.cache[objpath3b] = orig3b.obj; else delete require.cache[objpath3b];
    if (orig3b.igs) require.cache[igspath3b] = orig3b.igs; else delete require.cache[igspath3b];
    if (orig3b.svc) require.cache[svcpath3b] = orig3b.svc; else delete require.cache[svcpath3b];
    if (orig3b.ks)  require.cache[kspath3b]  = orig3b.ks;  else delete require.cache[kspath3b];
    if (orig3b.user) require.cache[userpath3b] = orig3b.user; else delete require.cache[userpath3b];
    if (orig3b.eps) require.cache[epspath3b] = orig3b.eps; else delete require.cache[epspath3b];
    // restore calibration (not stubbed, but clean up if polluted)
    delete require.cache[calpath3b];
    require(calpath3b);
  }
});
