'use strict';
/**
 * Wave 4 block 4 — interview 2-pass grading variance guard.
 *
 * The anchored grader runs twice for INSTITUTION assessments (env
 * INTERVIEW_TWO_PASS default ON); if the two overall scores diverge by more
 * than the threshold (10) the result is flagged needsReview + scoreVariance is
 * persisted. D2C sessions never run the second pass (cost).
 *
 * Same Module._load stub pattern as interviewHardening.test.js — no DB/LLM.
 */
const test = require('node:test');
const assert = require('node:assert');

const Module = require('module');
const originalLoad = Module._load;

const emptyChain = {
  sort: () => emptyChain,
  limit: () => emptyChain,
  select: () => emptyChain,
  lean: async () => [],
};

let fakeDoc = null;

const InterviewSessionStub = {
  updateMany: async () => {},
  find: () => emptyChain,
  findById: async () => fakeDoc,
  create: async (doc) => ({ ...doc, _id: 'ivSessStub' }),
};

const stubs = {
  '../models/InterviewSession': InterviewSessionStub,
  '../models/KnowledgeProfile': { findOne: async () => null },
  '../config/queue': {
    interviewEvaluationQueue: { add: async () => {} },
    notificationQueue: { add: async () => {} },
  },
  '../utils/apiError': class ApiError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  },
  '../config/aiProvider': {},
  '../config/openai': {},
  '../config/s3': { s3: {}, generateUploadURL: async () => {}, uploadBuffer: async () => {} },
  'node-fetch': async () => {},
  '../services/userContextService': { getUserContext: async () => ({}), summarize: () => '' },
  './userContextService': { getUserContext: async () => ({}), summarize: () => '' },
  './knowledgeService': { updateFromInterview: async () => {} },
  './plan/planProgressService': { onInterviewComplete: async () => {} },
};

Module._load = function (request) {
  if (stubs[request]) return stubs[request];
  return originalLoad.apply(this, arguments);
};

const interviewService = require('../../services/interviewService');

Module._load = originalLoad;

// ── Fixtures ─────────────────────────────────────────────────────────────────

const LONG = 'In my last project I profiled the API hot path and added a Redis cache, cutting p95 latency from 800ms to 120ms.';

function richTranscript() {
  return [
    { role: 'interviewer', content: 'Tell me about a performance problem you solved.', questionNumber: 1 },
    { role: 'candidate', content: LONG, questionNumber: 1, responseDuration: 40 },
    { role: 'interviewer', content: 'How do you approach debugging?', questionNumber: 2 },
    { role: 'candidate', content: LONG + ' I also add regression tests before closing the bug.', questionNumber: 2, responseDuration: 35 },
    { role: 'interviewer', content: 'Describe a conflict you resolved.', questionNumber: 3 },
    { role: 'candidate', content: LONG + ' We aligned on metrics and shipped together.', questionNumber: 3, responseDuration: 50 },
  ];
}

function makeSession({ isInstitutionAssessment = false } = {}) {
  return {
    _id: 'sess1',
    userId: { toString: () => 'user1' },
    interviewType: 'placement_technical',
    targetRole: 'SDE',
    targetCompany: 'Razorpay',
    difficulty: 'moderate',
    duration: 900,
    totalQuestions: 4,
    status: 'completed',
    isInstitutionAssessment,
    transcript: richTranscript(),
    expectedAnswers: [],
    integrity: { flaggedResponses: [], gazeAlerts: [], voiceAlerts: [] },
    evaluation: undefined,
    async save() {},
  };
}

function validEval(overallScore) {
  return {
    overallScore,
    summary: 'Specific answers about caching.',
    communication: { score: 70, feedback: 'clear' },
    content: { score: 78, feedback: 'specific' },
    structure: { score: 72, feedback: 'organised' },
    confidence: { score: 75, feedback: 'steady' },
    perQuestion: [],
    overallStrengths: ['metrics'],
    overallImprovements: ['frameworks'],
    integrityReport: { overallIntegrity: 'clean', flags: [], recommendation: '' },
  };
}

// Judge that always concurs (needsReview false, keeps grader overall).
const judgeConcur = {
  reconcile: async ({ graderResult }) => ({
    sampled: true, needsReview: false, regraded: false,
    judgeOverall: graderResult.overall, disagreement: 0, finalOverall: graderResult.overall,
  }),
};

/** aiProvider whose evaluateWithClaude returns the next score each call. */
function scriptedProvider(scores) {
  let i = 0;
  const calls = { n: 0 };
  return {
    calls,
    aiProvider: {
      evaluateWithClaude: async () => {
        calls.n += 1;
        const s = scores[Math.min(i, scores.length - 1)];
        i += 1;
        return validEval(s);
      },
    },
  };
}

function withEnv(value, fn) {
  const prev = process.env.INTERVIEW_TWO_PASS;
  if (value === undefined) delete process.env.INTERVIEW_TWO_PASS;
  else process.env.INTERVIEW_TWO_PASS = value;
  return fn().finally(() => {
    if (prev === undefined) delete process.env.INTERVIEW_TWO_PASS;
    else process.env.INTERVIEW_TWO_PASS = prev;
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('two-pass: institution + variance > 10 ⇒ needsReview + scoreVariance persisted', async () => {
  await withEnv(undefined, async () => { // default ON
    fakeDoc = makeSession({ isInstitutionAssessment: true });
    const { aiProvider, calls } = scriptedProvider([90, 70]); // |90-70| = 20 > 10
    const out = await interviewService.evaluateInterview('sess1', { aiProvider, gradeJudge: judgeConcur });
    assert.strictEqual(calls.n, 2, 'grader must run twice for an institution assessment');
    assert.strictEqual(out.evaluation.scoreVariance, 20);
    assert.strictEqual(out.evaluation.needsReview, true, 'variance > 10 must flag needsReview');
    assert.strictEqual(out.evaluation.overallScore, 90, 'primary grade is kept; two-pass only flags');
  });
});

test('two-pass: institution + variance <= 10 ⇒ scoreVariance set, needsReview stays false', async () => {
  await withEnv('true', async () => {
    fakeDoc = makeSession({ isInstitutionAssessment: true });
    const { aiProvider, calls } = scriptedProvider([80, 76]); // |80-76| = 4 <= 10
    const out = await interviewService.evaluateInterview('sess1', { aiProvider, gradeJudge: judgeConcur });
    assert.strictEqual(calls.n, 2);
    assert.strictEqual(out.evaluation.scoreVariance, 4);
    assert.strictEqual(out.evaluation.needsReview, false);
  });
});

test('two-pass: D2C session (isInstitutionAssessment false) never runs the second pass', async () => {
  await withEnv(undefined, async () => { // default ON, but D2C gate is off
    fakeDoc = makeSession({ isInstitutionAssessment: false });
    const { aiProvider, calls } = scriptedProvider([90, 70]);
    const out = await interviewService.evaluateInterview('sess1', { aiProvider, gradeJudge: judgeConcur });
    assert.strictEqual(calls.n, 1, 'D2C must grade exactly once (no two-pass)');
    assert.strictEqual(out.evaluation.scoreVariance, undefined, 'no variance recorded for D2C');
    assert.strictEqual(out.evaluation.needsReview, false);
  });
});

test('two-pass: INTERVIEW_TWO_PASS=false disables it even for institution', async () => {
  await withEnv('false', async () => {
    fakeDoc = makeSession({ isInstitutionAssessment: true });
    const { aiProvider, calls } = scriptedProvider([90, 70]);
    const out = await interviewService.evaluateInterview('sess1', { aiProvider, gradeJudge: judgeConcur });
    assert.strictEqual(calls.n, 1, 'env off ⇒ single grade even for institution');
    assert.strictEqual(out.evaluation.scoreVariance, undefined);
    assert.strictEqual(out.evaluation.needsReview, false);
  });
});

test('two-pass: a concurring judge does NOT clear a variance-driven needsReview (sticky)', async () => {
  await withEnv('true', async () => {
    fakeDoc = makeSession({ isInstitutionAssessment: true });
    const { aiProvider } = scriptedProvider([95, 60]); // variance 35 > 10
    const out = await interviewService.evaluateInterview('sess1', { aiProvider, gradeJudge: judgeConcur });
    assert.strictEqual(out.evaluation.needsReview, true, 'judge concurrence must not override the two-pass flag');
    assert.strictEqual(out.evaluation.scoreVariance, 35);
  });
});
