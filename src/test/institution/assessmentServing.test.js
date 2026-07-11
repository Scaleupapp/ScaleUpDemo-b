'use strict';
/**
 * Per-student MCQ serving: deterministic sample + question-order shuffle +
 * option shuffle with key remap (engineAdapters.mcq.start + _helpers).
 */
const test = require('node:test');
const assert = require('node:assert');
const { getAdapter, _helpers } = require('../../services/institution/assessment/engineAdapters');

function pool(n) {
  return Array.from({ length: n }, (_, i) => ({
    questionText: `Question number ${i}`,
    options: [
      { label: 'A', text: `opt-${i}-a` },
      { label: 'B', text: `opt-${i}-b` },
      { label: 'C', text: `opt-${i}-c` },
      { label: 'D', text: `opt-${i}-d` },
    ],
    correctAnswer: 'A', // key is always the '-a' option in the master
    qa: { lint: { passed: true } },
  }));
}

// Resolve the served correct-answer back to its option text so we can prove the
// key survived shuffling (label changed, but it still points at '-a').
function keyText(q) {
  const idx = q.correctAnswer.charCodeAt(0) - 65;
  return q.options[idx].text;
}

test('buildServedQuestions samples exactly `count` and is deterministic for a seed', () => {
  const p = pool(15);
  const a = _helpers.buildServedQuestions(p, 10, 'user1:assessA');
  const b = _helpers.buildServedQuestions(p, 10, 'user1:assessA');
  assert.strictEqual(a.length, 10, 'samples the per-student count');
  assert.deepStrictEqual(a.map((q) => q.questionText), b.map((q) => q.questionText), 'same seed → same sample+order');
  assert.deepStrictEqual(a.map((q) => q.options.map((o) => o.text)), b.map((q) => q.options.map((o) => o.text)), 'same seed → same option order');
});

test('different students get different variants (order and/or options)', () => {
  const p = pool(15);
  const a = _helpers.buildServedQuestions(p, 10, 'user1:assessA');
  const c = _helpers.buildServedQuestions(p, 10, 'user2:assessA');
  const sameOrder = a.map((q) => q.questionText).join('|') === c.map((q) => q.questionText).join('|');
  const sameOptions = JSON.stringify(a.map((q) => q.options.map((o) => o.text))) === JSON.stringify(c.map((q) => q.options.map((o) => o.text)));
  assert.ok(!(sameOrder && sameOptions), 'two students should not get an identical variant');
});

test('option shuffle remaps the key correctly and strips qa', () => {
  const p = pool(6);
  const served = _helpers.buildServedQuestions(p, 6, 'seed-remap');
  for (const q of served) {
    // key text must still be the original correct option ('-a') for that question
    assert.ok(keyText(q).endsWith('-a'), `served key must still point at the correct option, got ${keyText(q)}`);
    // labels are re-lettered A..D in served order
    assert.deepStrictEqual(q.options.map((o) => o.label), ['A', 'B', 'C', 'D']);
    // internal QA metadata never reaches the student
    assert.strictEqual(q.qa, undefined, 'qa must be stripped from served questions');
  }
});

test('mcq.start samples from the pool into a per-student clone (frozen master untouched)', async () => {
  const p = pool(15);
  let createdQuiz = null;
  const deps = {
    Quiz: { create: async (d) => { createdQuiz = d; return { _id: 'quizX', ...d }; } },
    QuizAttempt: { create: async (d) => ({ _id: 'attX', ...d }) },
  };
  const assessment = { _id: 'assessA', type: 'mcq', title: 'T', config: { mcq: { questions: p, questionCount: 10, totalQuestions: 10, topic: 'X' } } };

  const out = await getAdapter('mcq').start(assessment, 'user1', deps);
  assert.strictEqual(createdQuiz.questions.length, 10, 'clone holds the per-student count, not the full pool');
  assert.strictEqual(createdQuiz.totalQuestions, 10);
  assert.strictEqual(createdQuiz.source, 'institution_assessment');
  assert.strictEqual(String(out.engine.quizId), 'quizX');
  // Frozen master pool is untouched
  assert.strictEqual(p.length, 15, 'master pool length unchanged');
  assert.ok(p[0].qa, 'master retains qa metadata');
});

test('mcq.start re-entry for the same student is stable (deterministic clone)', async () => {
  const p = pool(15);
  const clones = [];
  const deps = {
    Quiz: { create: async (d) => { clones.push(d); return { _id: 'q', ...d }; } },
    QuizAttempt: { create: async (d) => ({ _id: 'a', ...d }) },
  };
  const assessment = { _id: 'assessA', type: 'mcq', title: 'T', config: { mcq: { questions: p, questionCount: 10, totalQuestions: 10, topic: 'X' } } };

  await getAdapter('mcq').start(assessment, 'userStable', deps);
  await getAdapter('mcq').start(assessment, 'userStable', deps);
  assert.deepStrictEqual(
    clones[0].questions.map((q) => q.questionText),
    clones[1].questions.map((q) => q.questionText),
    're-entry yields the identical served set',
  );
});
