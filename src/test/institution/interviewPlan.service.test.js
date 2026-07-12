'use strict';
/**
 * Block 4 (Wave 2) — interview question-side gates.
 *
 * Lint rules are pure — tested directly. Generation + judge are DI-stubbed.
 * authorInterview is exercised with an injected Assessment model stub
 * (mirrors the authorMcq test approach — no DB / LLM).
 */
const test = require('node:test');
const assert = require('node:assert');

const plan = require('../../services/institution/assessment/interviewPlanService');
const authoring = require('../../services/institution/assessment/assessmentAuthoringService');
const { releaseAssessment } = require('../../services/institution/assessment/assessmentService');

// releaseAssessment fires authorAgentClosure.closeOnLifecycle fire-and-forget
// (Plan 3, Task 3) — stub it so these DI-stubbed tests stay real-DB-free.
const NOOP_AUTHOR_AGENT_CLOSURE = { authorAgentClosure: { closeOnLifecycle: async () => ({ closed: false }) } };

// ── Fixtures ─────────────────────────────────────────────────────────────────

function goodQuestions(n = 10) {
  const topics = [
    'binary search trees', 'hash map collision handling', 'REST API design',
    'database indexing strategy', 'concurrency and race conditions',
    'system design for a URL shortener', 'debugging a memory leak',
    'test-driven development practice', 'code review priorities',
    'caching layer trade-offs', 'message queue back-pressure', 'pagination design',
  ];
  return Array.from({ length: n }, (_, i) => ({
    question: `How would you approach ${topics[i % topics.length]} in a production service?`,
    outline: `Covers the key trade-offs of ${topics[i % topics.length]}, a concrete example, and how to verify the approach.`,
  }));
}

// ── Gate 1: lintPlan (pure) ──────────────────────────────────────────────────

test('lintPlan passes a well-formed 10-question plan', () => {
  const r = plan.lintPlan(goodQuestions(10));
  assert.deepStrictEqual(r, { passed: true, failures: [] });
});

test('lintPlan fails on count out of range', () => {
  assert.ok(plan.lintPlan(goodQuestions(3)).failures.some((f) => f.startsWith('bad_count')));
  assert.ok(plan.lintPlan(goodQuestions(15) ? goodQuestions(12).concat(goodQuestions(3)) : []).failures.some((f) => f.startsWith('bad_count')));
});

test('lintPlan fails on missing question/outline', () => {
  const qs = goodQuestions(10);
  qs[2] = { question: '', outline: 'x' };
  qs[3] = { question: 'What is sharding in databases?', outline: '' };
  const r = plan.lintPlan(qs);
  assert.ok(r.failures.includes('missing_question:2'));
  assert.ok(r.failures.includes('missing_outline:3'));
});

test('lintPlan fails on compound (multi-question) items', () => {
  const qs = goodQuestions(10);
  qs[0] = { question: 'What is a mutex? And how does it differ from a semaphore?', outline: 'locking primitives' };
  assert.ok(plan.lintPlan(qs).failures.includes('multi_question:0'));
});

test('lintPlan fails on answer-revealing preamble', () => {
  const qs = goodQuestions(10);
  qs[1] = { question: 'A strong answer would mention indexing — how do you speed up slow queries?', outline: 'indexing' };
  assert.ok(plan.lintPlan(qs).failures.includes('answer_leak:1'));
});

test('lintPlan fails on near-duplicate questions', () => {
  const qs = goodQuestions(10);
  qs[5] = { ...qs[4] };
  assert.ok(plan.lintPlan(qs).failures.some((f) => f.startsWith('duplicate:5')));
});

// ── Gate 3: shapeJudge ───────────────────────────────────────────────────────

test('shapeJudge accepts all-≥3 scores, rejects any ≤2, rejects bad shape', () => {
  const good = plan.shapeJudge({ scores: { relevance: 4, difficultyHonesty: 4, coverage: 5, realism: 3 }, notes: 'ok' });
  assert.strictEqual(good.verdict, 'accept');
  const low = plan.shapeJudge({ scores: { relevance: 4, difficultyHonesty: 2, coverage: 5, realism: 3 } });
  assert.strictEqual(low.verdict, 'reject');
  assert.deepStrictEqual(low.reasons, ['judge_low_difficultyHonesty']);
  const bad = plan.shapeJudge({ nope: true });
  assert.strictEqual(bad.verdict, 'reject');
  assert.deepStrictEqual(bad.reasons, ['judge_invalid']);
});

// ── Orchestrator ─────────────────────────────────────────────────────────────

const acceptJudge = async () => ({ verdict: 'accept', valid: true, scores: { relevance: 4, difficultyHonesty: 4, coverage: 4, realism: 4 }, reasons: [] });

test('buildQuestionPlan: pass on first round', async () => {
  const r = await plan.buildQuestionPlan({}, {
    generatePlan: async () => goodQuestions(10),
    judgePlan: acceptJudge,
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.rounds, 1);
  assert.strictEqual(r.questions.length, 10);
});

test('buildQuestionPlan: judge rejects once ⇒ regenerates once and passes', async () => {
  let genCalls = 0;
  let judgeCalls = 0;
  const critiques = [];
  const r = await plan.buildQuestionPlan({}, {
    generatePlan: async (ctx) => { genCalls += 1; critiques.push(ctx.critique); return goodQuestions(10); },
    judgePlan: async () => {
      judgeCalls += 1;
      if (judgeCalls === 1) return { verdict: 'reject', valid: true, reasons: ['judge_low_coverage'], notes: 'too narrow' };
      return acceptJudge();
    },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(genCalls, 2);
  assert.ok(critiques[1].includes('judge_low_coverage'), 'regeneration receives the rejection critique');
});

test('buildQuestionPlan: fails after max rounds with honest error', async () => {
  const r = await plan.buildQuestionPlan({}, {
    generatePlan: async () => goodQuestions(3), // always lint-fails
    judgePlan: acceptJudge,
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.rounds, plan.constants.MAX_ROUNDS);
  assert.ok(/lint failed/.test(r.error));
});

// ── authorInterview ──────────────────────────────────────────────────────────

function makeAssessmentDoc(over = {}) {
  const doc = {
    _id: 'a1',
    type: 'interview',
    status: 'configured',
    config: { interview: { interviewType: 'placement_technical', targetRole: 'SDE', targetCompany: 'Acme', difficulty: 'moderate' } },
    markModified() {},
    async save() {},
    ...over,
  };
  return doc;
}

function makeAssessmentModel(doc, { matched = 1 } = {}) {
  const updates = [];
  return {
    updates,
    findById: async () => doc,
    updateOne: async (filter, update) => { updates.push({ filter, update }); return { matchedCount: matched }; },
  };
}

test('authorInterview: success ⇒ authoring ready with questionPlan persisted', async () => {
  const doc = makeAssessmentDoc();
  const Assessment = makeAssessmentModel(doc);
  await authoring.authorInterview('a1', {
    Assessment,
    interviewPlanService: {
      buildQuestionPlan: async (ctx) => {
        assert.strictEqual(ctx.targetCompany, 'Acme', 'targetCompany threaded into the plan ctx');
        return { ok: true, questions: goodQuestions(10), judge: { verdict: 'accept' }, lint: { passed: true }, rounds: 1 };
      },
    },
  });
  const last = Assessment.updates[Assessment.updates.length - 1];
  const iv = last.update.$set['config.interview'];
  assert.strictEqual(iv.authoring.status, 'ready');
  assert.strictEqual(iv.authoring.questionPlan.questions.length, 10);
  assert.ok(iv.authoring.questionPlan.questions[0].outline, 'expected-answer outlines persisted');
});

test('authorInterview: QA failure ⇒ honest failed status with error', async () => {
  const doc = makeAssessmentDoc();
  const Assessment = makeAssessmentModel(doc);
  await authoring.authorInterview('a1', {
    Assessment,
    interviewPlanService: { buildQuestionPlan: async () => ({ ok: false, rounds: 2, error: 'judge rejected: judge_low_relevance' }) },
  });
  const last = Assessment.updates[Assessment.updates.length - 1];
  const iv = last.update.$set['config.interview'];
  assert.strictEqual(iv.authoring.status, 'failed');
  assert.ok(iv.authoring.error.includes('judge_low_relevance'));
  assert.strictEqual(iv.authoring.questionPlan, null);
});

test('authorInterview: crash ⇒ failed status persisted and rethrown', async () => {
  const doc = makeAssessmentDoc();
  const Assessment = makeAssessmentModel(doc);
  await assert.rejects(
    () => authoring.authorInterview('a1', {
      Assessment,
      interviewPlanService: { buildQuestionPlan: async () => { throw new Error('LLM down'); } },
    }),
    /LLM down/
  );
  const last = Assessment.updates[Assessment.updates.length - 1];
  assert.strictEqual(last.update.$set['config.interview'].authoring.status, 'failed');
});

test('authorInterview: non-interview type returns null (no-op)', async () => {
  const doc = makeAssessmentDoc({ type: 'mcq', config: { mcq: {} } });
  const Assessment = makeAssessmentModel(doc);
  const r = await authoring.authorInterview('a1', { Assessment, interviewPlanService: {} });
  assert.strictEqual(r, null);
});

// ── Release gate ─────────────────────────────────────────────────────────────

function releaseModel(doc) {
  return { findOne: async () => doc };
}

test('releaseAssessment: interview authoring failed ⇒ AUTHORING_FAILED', async () => {
  const doc = makeAssessmentDoc();
  doc.config.interview.authoring = { status: 'failed', error: 'x' };
  await assert.rejects(
    () => releaseAssessment({ institutionId: 'i1' }, 'a1', 'u1', { Assessment: releaseModel(doc) }),
    /AUTHORING_FAILED/
  );
});

test('releaseAssessment: interview authoring generating ⇒ NO_QUESTIONS', async () => {
  const doc = makeAssessmentDoc();
  doc.config.interview.authoring = { status: 'generating' };
  await assert.rejects(
    () => releaseAssessment({ institutionId: 'i1' }, 'a1', 'u1', { Assessment: releaseModel(doc) }),
    /NO_QUESTIONS/
  );
});

test('releaseAssessment: interview authoring ready ⇒ releases', async () => {
  const doc = makeAssessmentDoc();
  doc.config.interview.authoring = { status: 'ready', questionPlan: { questions: goodQuestions(10) } };
  doc.save = async function () { return this; };
  const out = await releaseAssessment({ institutionId: 'i1' }, 'a1', 'u1', { Assessment: releaseModel(doc), ...NOOP_AUTHOR_AGENT_CLOSURE });
  assert.strictEqual(out.status, 'released');
});

test('releaseAssessment: legacy interview with no authoring still releases', async () => {
  const doc = makeAssessmentDoc();
  doc.save = async function () { return this; };
  const out = await releaseAssessment({ institutionId: 'i1' }, 'a1', 'u1', { Assessment: releaseModel(doc), ...NOOP_AUTHOR_AGENT_CLOSURE });
  assert.strictEqual(out.status, 'released');
});
