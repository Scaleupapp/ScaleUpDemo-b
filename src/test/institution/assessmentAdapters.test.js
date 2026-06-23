'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { getAdapter } = require('../../services/institution/assessment/engineAdapters');

test('mcq adapter.start clones a Quiz from frozen questions and starts an attempt', async () => {
  let createdQuiz = null, createdAttempt = null;
  const deps = {
    Quiz: { create: async (d) => { createdQuiz = d; return { _id: 'quiz1', ...d }; } },
    QuizAttempt: { create: async (d) => { createdAttempt = d; return { _id: 'att1', ...d }; } },
  };
  const assessment = { _id: 'a1', type: 'mcq', config: { mcq: { questions: [{ questionText: 'q' }], totalQuestions: 1 } } };
  const out = await getAdapter('mcq').start(assessment, 'u1', deps);
  assert.strictEqual(createdQuiz.userId, 'u1');
  assert.deepStrictEqual(createdQuiz.questions, [{ questionText: 'q' }]);
  assert.strictEqual(out.engine.type, 'mcq');
  assert.strictEqual(String(out.engine.quizId), 'quiz1');
  assert.strictEqual(String(out.engine.sessionId), 'att1');
});

test('mcq adapter.readResult reports done with score when the attempt is completed', async () => {
  const deps = { QuizAttempt: { findById: async () => ({ status: 'completed', score: { percentage: 72 }, competencyBreakdown: [{ competency: 'DSA', percentage: 70 }] }) } };
  const r = await getAdapter('mcq').readResult({ engine: { sessionId: 'att1' } }, deps);
  assert.strictEqual(r.done, true);
  assert.strictEqual(r.score, 72);
});

test('mcq adapter.readResult reports not-done while in_progress', async () => {
  const deps = { QuizAttempt: { findById: async () => ({ status: 'in_progress' }) } };
  const r = await getAdapter('mcq').readResult({ engine: { sessionId: 'att1' } }, deps);
  assert.strictEqual(r.done, false);
});

test('capstone adapter.readResult maps graded result', async () => {
  const deps = { CapstoneSession: { findById: async () => ({ status: 'graded', result: { overall_score: 81, integrity_confidence: 'high' } }) } };
  const r = await getAdapter('capstone').readResult({ engine: { sessionId: 's1' } }, deps);
  assert.strictEqual(r.done, true);
  assert.strictEqual(r.score, 81);
  assert.strictEqual(r.integrity, 'high');
});

test('interview adapter.readResult maps evaluated result', async () => {
  const deps = { InterviewSession: { findById: async () => ({ status: 'evaluated', evaluation: { overallScore: 68, integrityReport: { overallIntegrity: 'clean' } } }) } };
  const r = await getAdapter('interview').readResult({ engine: { sessionId: 's1' } }, deps);
  assert.strictEqual(r.done, true);
  assert.strictEqual(r.score, 68);
  assert.strictEqual(r.integrity, 'clean');
});

test('getAdapter throws on unknown type', () => {
  assert.throws(() => getAdapter('essay'));
});
