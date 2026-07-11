'use strict';
/**
 * Block 3 (Wave 2) — interview grading hardening.
 *
 * Covers:
 *  - countSubstantiveAnswers / validateEvaluationShape (pure helpers)
 *  - min-transcript gate (<3 substantive answers ⇒ gradeStatus 'insufficient',
 *    score null, session evaluated — never stuck, never a fake 0-100)
 *  - STRICT eval shape validation (invalid ⇒ retry once ⇒ throw + status revert)
 *  - targetCompany + expectedAnswers threading into generation & grading prompts
 *  - answer-side judge wiring (divergent ⇒ needsReview persisted)
 *
 * Uses the same Module._load stub pattern as interviewContext.test.js —
 * no DB / Redis / LLM.
 */
const test = require('node:test');
const assert = require('node:assert');

const Module = require('module');
const originalLoad = Module._load;

const capturedSessions = [];

const emptyChain = {
  sort: () => emptyChain,
  limit: () => emptyChain,
  select: () => emptyChain,
  lean: async () => [],
};

// findById returns the currently-installed fake doc (set per test).
let fakeDoc = null;

const InterviewSessionStub = {
  updateMany: async () => {},
  find: () => emptyChain,
  findById: async () => fakeDoc,
  create: async (doc) => {
    capturedSessions.push(doc);
    return { ...doc, _id: 'ivSessStub' };
  },
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

const { countSubstantiveAnswers, validateEvaluationShape, MIN_SUBSTANTIVE_ANSWERS } =
  interviewService._helpers;

// ── Fixtures ─────────────────────────────────────────────────────────────────

const LONG = 'In my last project I profiled the API hot path and added a Redis cache, cutting p95 latency from 800ms to 120ms.';

function makeSession({ transcript, expectedAnswers } = {}) {
  const doc = {
    _id: 'sess1',
    userId: { toString: () => 'user1' },
    interviewType: 'placement_technical',
    targetRole: 'SDE',
    targetCompany: 'Razorpay',
    difficulty: 'moderate',
    duration: 900,
    totalQuestions: 4,
    status: 'completed',
    transcript: transcript || [],
    expectedAnswers: expectedAnswers || [],
    integrity: { flaggedResponses: [], gazeAlerts: [], voiceAlerts: [] },
    evaluation: undefined,
    saves: [],
    async save() { this.saves.push({ status: this.status, evaluation: this.evaluation }); },
  };
  return doc;
}

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

function validEval(overrides = {}) {
  return {
    overallScore: 74,
    summary: 'Good, specific answers about caching.',
    communication: { score: 70, feedback: 'clear' },
    content: { score: 78, feedback: 'specific' },
    structure: { score: 72, feedback: 'organised' },
    confidence: { score: 75, feedback: 'steady' },
    perQuestion: [],
    overallStrengths: ['specific metrics'],
    overallImprovements: ['more frameworks'],
    integrityReport: { overallIntegrity: 'clean', flags: [], recommendation: '' },
    ...overrides,
  };
}

const judgeConcur = {
  reconcile: async ({ graderResult }) => ({
    sampled: true, needsReview: false, regraded: false,
    judgeOverall: graderResult.overall, disagreement: 0, finalOverall: graderResult.overall,
  }),
};

// ── Pure helpers ─────────────────────────────────────────────────────────────

test('countSubstantiveAnswers: filters short/non-candidate entries', () => {
  const t = [
    { role: 'candidate', content: 'yes' },                    // too short
    { role: 'candidate', content: LONG },                     // counts
    { role: 'interviewer', content: LONG },                   // wrong role
    { role: 'candidate', content: LONG + ' more detail.' },   // counts
  ];
  assert.strictEqual(countSubstantiveAnswers(t), 2);
  assert.strictEqual(countSubstantiveAnswers([]), 0);
  assert.strictEqual(countSubstantiveAnswers(null), 0);
});

test('validateEvaluationShape: accepts a well-formed evaluation', () => {
  assert.strictEqual(validateEvaluationShape(validEval()), true);
});

test('validateEvaluationShape: rejects missing/invalid overallScore', () => {
  assert.strictEqual(validateEvaluationShape(validEval({ overallScore: undefined })), false);
  assert.strictEqual(validateEvaluationShape(validEval({ overallScore: 'high' })), false);
  assert.strictEqual(validateEvaluationShape(validEval({ overallScore: 150 })), false);
});

test('validateEvaluationShape: rejects missing dimension scores + perQuestion', () => {
  assert.strictEqual(validateEvaluationShape(validEval({ communication: {} })), false);
  assert.strictEqual(validateEvaluationShape(validEval({ content: undefined })), false);
  assert.strictEqual(validateEvaluationShape(validEval({ perQuestion: undefined })), false);
  assert.strictEqual(validateEvaluationShape({ text: 'not json' }), false);
  assert.strictEqual(validateEvaluationShape(null), false);
});

// ── Min-transcript gate ──────────────────────────────────────────────────────

test('evaluateInterview: <3 substantive answers ⇒ insufficient (score null, evaluated, flagged)', async () => {
  fakeDoc = makeSession({
    transcript: [
      { role: 'interviewer', content: 'Q1?', questionNumber: 1 },
      { role: 'candidate', content: 'yes', questionNumber: 1 },
      { role: 'candidate', content: LONG, questionNumber: 2 },
    ],
  });
  let llmCalled = false;
  const out = await interviewService.evaluateInterview('sess1', {
    aiProvider: { evaluateWithClaude: async () => { llmCalled = true; return validEval(); } },
    gradeJudge: judgeConcur,
  });
  assert.strictEqual(llmCalled, false, 'LLM must not be called for an insufficient transcript');
  assert.strictEqual(out.status, 'evaluated', 'session must terminate, never stuck');
  assert.strictEqual(out.evaluation.gradeStatus, 'insufficient');
  assert.strictEqual(out.evaluation.overallScore, null, 'score must be null, not a 0-100');
  assert.strictEqual(out.evaluation.needsReview, true);
  assert.ok(out.evaluation.summary.includes(String(MIN_SUBSTANTIVE_ANSWERS)));
});

// ── Happy path + prompt threading ────────────────────────────────────────────

test('evaluateInterview: valid shape saved; prompts carry company, anchors, expected answers', async () => {
  fakeDoc = makeSession({
    transcript: richTranscript(),
    expectedAnswers: [{ question: 'Perf problem?', outline: 'profiling, caching, p95 metrics' }],
  });
  const prompts = [];
  const out = await interviewService.evaluateInterview('sess1', {
    aiProvider: { evaluateWithClaude: async (args) => { prompts.push(args); return validEval(); } },
    gradeJudge: judgeConcur,
  });
  assert.strictEqual(out.status, 'evaluated');
  assert.strictEqual(out.evaluation.gradeStatus, 'graded');
  assert.strictEqual(out.evaluation.overallScore, 74);
  assert.strictEqual(out.evaluation.needsReview, false);

  const { systemPrompt, userPrompt } = prompts[0];
  assert.ok(systemPrompt.includes('Razorpay'), 'grading system prompt must carry targetCompany');
  assert.ok(userPrompt.includes('Razorpay'), 'grading user prompt must carry targetCompany');
  assert.ok(userPrompt.includes('SCORING ANCHORS'), 'anchored rubric must be in the eval prompt');
  assert.ok(userPrompt.includes('CALIBRATION EXEMPLAR'), 'calibration exemplar must be in the eval prompt');
  assert.ok(userPrompt.includes('EXPECTED-ANSWER OUTLINES'), 'expected-answer anchors must be in the eval prompt');
  assert.ok(userPrompt.includes('profiling, caching, p95 metrics'));
});

// ── Shape validation: retry then throw ───────────────────────────────────────

test('evaluateInterview: invalid shape once ⇒ retried once and saved', async () => {
  fakeDoc = makeSession({ transcript: richTranscript() });
  let calls = 0;
  const out = await interviewService.evaluateInterview('sess1', {
    aiProvider: { evaluateWithClaude: async () => { calls += 1; return calls === 1 ? { text: 'garbage' } : validEval(); } },
    gradeJudge: judgeConcur,
  });
  assert.strictEqual(calls, 2, 'must retry exactly once');
  assert.strictEqual(out.evaluation.overallScore, 74);
});

test('evaluateInterview: invalid shape twice ⇒ throws and reverts to completed (never saves undefined scores)', async () => {
  fakeDoc = makeSession({ transcript: richTranscript() });
  await assert.rejects(
    () => interviewService.evaluateInterview('sess1', {
      aiProvider: { evaluateWithClaude: async () => ({ text: 'garbage' }) },
      gradeJudge: judgeConcur,
    }),
    /invalid evaluation shape/
  );
  assert.strictEqual(fakeDoc.status, 'completed', 'status reverted so the worker can retry');
  assert.ok(!fakeDoc.evaluation || fakeDoc.evaluation.overallScore === undefined,
    'no undefined-score evaluation may be persisted');
});

// ── Judge wiring ─────────────────────────────────────────────────────────────

test('evaluateInterview: divergent judge ⇒ needsReview persisted with telemetry', async () => {
  fakeDoc = makeSession({ transcript: richTranscript() });
  const out = await interviewService.evaluateInterview('sess1', {
    aiProvider: { evaluateWithClaude: async () => validEval({ overallScore: 90 }) },
    gradeJudge: {
      reconcile: async () => ({
        sampled: true, needsReview: true, regraded: true,
        judgeOverall: 50, disagreement: 38, finalOverall: 88,
      }),
    },
  });
  assert.strictEqual(out.evaluation.needsReview, true);
  assert.strictEqual(out.evaluation.judgeOverall, 50);
  assert.strictEqual(out.evaluation.judgeDisagreement, 38);
  assert.strictEqual(out.evaluation.overallScore, 88, 'finalOverall from the judge flow wins');
  assert.strictEqual(out.status, 'evaluated');
});

test('evaluateInterview: judge crash is non-fatal (grade still saved)', async () => {
  fakeDoc = makeSession({ transcript: richTranscript() });
  const out = await interviewService.evaluateInterview('sess1', {
    aiProvider: { evaluateWithClaude: async () => validEval() },
    gradeJudge: { reconcile: async () => { throw new Error('judge down'); } },
  });
  assert.strictEqual(out.status, 'evaluated');
  assert.strictEqual(out.evaluation.overallScore, 74);
  assert.strictEqual(out.evaluation.needsReview, false);
});

// ── startInterview threading ─────────────────────────────────────────────────

test('startInterview: targetCompany lands in the generation systemInstruction', async () => {
  capturedSessions.length = 0;
  await interviewService.startInterview('user1', {
    interviewType: 'placement_technical',
    targetRole: 'SDE',
    targetCompany: 'Razorpay',
    abandonExisting: false,
  });
  assert.ok(capturedSessions[0].systemInstruction.includes('Company: Razorpay'));
});

test('startInterview: expectedAnswers persisted on the session', async () => {
  capturedSessions.length = 0;
  await interviewService.startInterview('user1', {
    interviewType: 'placement_technical',
    targetRole: 'SDE',
    abandonExisting: false,
    expectedAnswers: [
      { question: 'Q1', outline: 'ideal outline' },
      { bad: true }, // filtered
    ],
  });
  const saved = capturedSessions[0].expectedAnswers;
  assert.ok(Array.isArray(saved));
  assert.strictEqual(saved.length, 1);
  assert.strictEqual(saved[0].question, 'Q1');
  assert.strictEqual(saved[0].outline, 'ideal outline');
});
