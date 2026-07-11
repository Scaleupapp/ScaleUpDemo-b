'use strict';
/**
 * Tests for src/services/institution/assessment/questionQaService.js
 *
 * Gate-1 lint rules are pure — tested directly (pass + fail cases).
 * Gate-2 (blind solve) and Gate-3 (judge) LLM calls are DI-stubbed.
 */
const test = require('node:test');
const assert = require('node:assert');
const qa = require('../../services/institution/assessment/questionQaService');

// A clean, lint-passing question factory.
function goodQ(overrides = {}) {
  return {
    questionText: 'Which structure offers O(1) average lookup by key value?',
    options: [
      { label: 'A', text: 'Hash map' },
      { label: 'B', text: 'Sorted array' },
      { label: 'C', text: 'Linked list' },
      { label: 'D', text: 'Binary heap' },
    ],
    correctAnswer: 'A',
    difficulty: 'easy',
    ...overrides,
  };
}

// ── Gate 1: checkSchema ───────────────────────────────────────────────────────

test('checkSchema passes a well-formed question', () => {
  assert.strictEqual(qa.checkSchema(goodQ()), null);
});
test('checkSchema fails on missing stem', () => {
  assert.strictEqual(qa.checkSchema(goodQ({ questionText: '' })), 'missing_stem');
});
test('checkSchema fails on no options', () => {
  assert.strictEqual(qa.checkSchema(goodQ({ options: [] })), 'no_options');
});
test('checkSchema fails on unresolvable key', () => {
  assert.strictEqual(qa.checkSchema(goodQ({ correctAnswer: 'Z' })), 'unresolved_key');
});
test('checkSchema fails on empty option text', () => {
  const q = goodQ();
  q.options[2].text = '';
  assert.strictEqual(qa.checkSchema(q), 'empty_option');
});

// ── Gate 1: checkFourDistinctOptions ──────────────────────────────────────────

test('checkFourDistinctOptions passes 4 distinct options', () => {
  assert.strictEqual(qa.checkFourDistinctOptions(goodQ()), null);
});
test('checkFourDistinctOptions fails when not exactly 4', () => {
  const q = goodQ();
  q.options = q.options.slice(0, 3);
  assert.strictEqual(qa.checkFourDistinctOptions(q), 'not_four_options');
});
test('checkFourDistinctOptions fails on duplicate option text', () => {
  const q = goodQ();
  q.options[1].text = 'Hash map'; // dup of key
  assert.strictEqual(qa.checkFourDistinctOptions(q), 'duplicate_options');
});

// ── Gate 1: checkSingleKey ────────────────────────────────────────────────────

test('checkSingleKey passes with one resolvable key', () => {
  assert.strictEqual(qa.checkSingleKey(goodQ()), null);
});
test('checkSingleKey fails when key is unresolvable', () => {
  assert.strictEqual(qa.checkSingleKey(goodQ({ correctAnswer: null })), 'no_single_key');
});

// ── Gate 1: checkLetterDistribution (set-level) ───────────────────────────────

test('checkLetterDistribution passes a balanced set', () => {
  const set = [
    goodQ({ correctAnswer: 'A' }), goodQ({ correctAnswer: 'B' }),
    goodQ({ correctAnswer: 'C' }), goodQ({ correctAnswer: 'D' }),
  ];
  const r = qa.checkLetterDistribution(set);
  assert.strictEqual(r.passed, true);
  assert.strictEqual(r.ratio, 0.25);
});
test('checkLetterDistribution fails a skewed set (>45% one letter)', () => {
  const set = [
    goodQ({ correctAnswer: 'A' }), goodQ({ correctAnswer: 'A' }),
    goodQ({ correctAnswer: 'A' }), goodQ({ correctAnswer: 'B' }),
  ];
  const r = qa.checkLetterDistribution(set);
  assert.strictEqual(r.passed, false);
  assert.strictEqual(r.dominantLetter, 'A');
  assert.ok(r.ratio > 0.45);
});

// ── Gate 1: checkLengthBias ───────────────────────────────────────────────────

test('checkLengthBias passes when key is similar length', () => {
  assert.strictEqual(qa.checkLengthBias(goodQ()), null);
});
test('checkLengthBias fails when key is >40% longer than mean distractor', () => {
  const q = goodQ({
    options: [
      { label: 'A', text: 'This is the fully detailed and textbook-worded correct answer option here' },
      { label: 'B', text: 'Short' },
      { label: 'C', text: 'Brief' },
      { label: 'D', text: 'Tiny' },
    ],
    correctAnswer: 'A',
  });
  assert.strictEqual(qa.checkLengthBias(q), 'length_bias');
});

// ── Gate 1: checkStemKeywordLeak ──────────────────────────────────────────────

test('checkStemKeywordLeak passes when no distinctive token leaks', () => {
  assert.strictEqual(qa.checkStemKeywordLeak(goodQ()), null);
});
test('checkStemKeywordLeak fails when a >=7-char token is shared by stem+key only', () => {
  const q = {
    questionText: 'What handles polymorphism cleanly in this scenario?',
    options: [
      { label: 'A', text: 'A polymorphism-aware dispatcher' }, // shares "polymorphism" with stem
      { label: 'B', text: 'A simple counter' },
      { label: 'C', text: 'A basic loop' },
      { label: 'D', text: 'A plain list' },
    ],
    correctAnswer: 'A',
  };
  assert.strictEqual(qa.checkStemKeywordLeak(q), 'stem_keyword_leak');
});

// ── Gate 1: checkTopicEcho ────────────────────────────────────────────────────

test('checkTopicEcho passes when topic tokens appear', () => {
  assert.strictEqual(qa.checkTopicEcho(goodQ(), 'lookup structures'), null);
});
test('checkTopicEcho fails when no topic token appears', () => {
  assert.strictEqual(qa.checkTopicEcho(goodQ(), 'photosynthesis chlorophyll'), 'topic_echo_missing');
});
test('checkTopicEcho is a no-op when topic is absent', () => {
  assert.strictEqual(qa.checkTopicEcho(goodQ(), ''), null);
});

// ── Gate 1: checkDedup (set-level) ────────────────────────────────────────────

test('checkDedup finds no duplicates in distinct stems', () => {
  const set = [
    goodQ({ questionText: 'What is a hash map lookup complexity here?' }),
    goodQ({ questionText: 'Explain the time cost of a linked list traversal.' }),
  ];
  assert.deepStrictEqual(qa.checkDedup(set), []);
});
test('checkDedup flags a near-identical later stem', () => {
  const stem = 'Which structure offers constant average lookup by key value today?';
  const set = [goodQ({ questionText: stem }), goodQ({ questionText: stem })];
  const dups = qa.checkDedup(set);
  assert.strictEqual(dups.length, 1);
  assert.strictEqual(dups[0].index, 1);
  assert.strictEqual(dups[0].dupOf, 0);
});

// ── Gate 1: lintQuestion aggregate ────────────────────────────────────────────

test('lintQuestion passes a clean question', () => {
  const r = qa.lintQuestion(goodQ(), { topic: 'data structures lookup' });
  assert.strictEqual(r.passed, true);
  assert.deepStrictEqual(r.failures, []);
});
test('lintQuestion collects multiple failures', () => {
  const q = goodQ({ options: [{ label: 'A', text: 'x' }, { label: 'B', text: 'x' }], correctAnswer: 'A' });
  const r = qa.lintQuestion(q, { topic: 'linked lists' });
  assert.strictEqual(r.passed, false);
  assert.ok(r.failures.includes('not_four_options'));
});

// ── Gate 2: blindSolve (DI-stubbed) ───────────────────────────────────────────

test('blindSolve agrees when solver picks the key with high confidence', async () => {
  const analyzeWithClaude = async () => ({ answer: 'A', confidence: 0.9 });
  const r = await qa.blindSolve(goodQ(), { analyzeWithClaude });
  assert.strictEqual(r.agrees, true);
  assert.strictEqual(r.ambiguous, false);
  assert.strictEqual(r.valid, true);
});
test('blindSolve rejects (mismatch) when solver picks a different letter', async () => {
  const analyzeWithClaude = async () => ({ answer: 'C', confidence: 0.8 });
  const r = await qa.blindSolve(goodQ(), { analyzeWithClaude });
  assert.strictEqual(r.agrees, false);
});
test('blindSolve flags ambiguous on low confidence', async () => {
  const analyzeWithClaude = async () => ({ answer: 'A', confidence: 0.4 });
  const r = await qa.blindSolve(goodQ(), { analyzeWithClaude });
  assert.strictEqual(r.agrees, true);
  assert.strictEqual(r.ambiguous, true);
});
test('blindSolve treats an invalid LLM shape as non-agreement', async () => {
  const analyzeWithClaude = async () => ({ text: 'I am not JSON' });
  const r = await qa.blindSolve(goodQ(), { analyzeWithClaude });
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.agrees, false);
});

// ── Gate 3: judgeQuestion (DI-stubbed) ────────────────────────────────────────

const fullScores = { clarity: 5, singleAnswer: 5, distractorPlausibility: 4, difficultyHonesty: 4, topicRelevance: 5 };

test('judgeQuestion accepts when all dimensions >= 3', async () => {
  const analyzeWithClaude = async () => ({ scores: fullScores, notes: 'ok' });
  const r = await qa.judgeQuestion(goodQ(), { topic: 'x' }, { analyzeWithClaude });
  assert.strictEqual(r.verdict, 'accept');
});
test('judgeQuestion rejects when any dimension <= 2', async () => {
  const analyzeWithClaude = async () => ({ scores: { ...fullScores, distractorPlausibility: 2 }, notes: 'weak distractors' });
  const r = await qa.judgeQuestion(goodQ(), { topic: 'x' }, { analyzeWithClaude });
  assert.strictEqual(r.verdict, 'reject');
  assert.ok(r.reasons.includes('judge_low_distractorPlausibility'));
});
test('judgeQuestion rejects on invalid judge output', async () => {
  const analyzeWithClaude = async () => ({ text: 'not scores' });
  const r = await qa.judgeQuestion(goodQ(), { topic: 'x' }, { analyzeWithClaude });
  assert.strictEqual(r.verdict, 'reject');
  assert.strictEqual(r.valid, false);
});

// ── runQa orchestrator ────────────────────────────────────────────────────────

function passAllDeps() {
  return {
    blindSolve: async () => ({ agrees: true, confidence: 0.9, ambiguous: false, valid: true, answer: 'A' }),
    judgeQuestion: async () => ({ verdict: 'accept', scores: fullScores, valid: true }),
  };
}

test('runQa passes clean questions through all gates and attaches qa', async () => {
  const questions = [goodQ(), goodQ({ questionText: 'Explain the average cost of a linked list traversal operation.' })];
  const { passed, rejected, report } = await qa.runQa(questions, { topic: 'linked lists', round: 0 }, passAllDeps());
  assert.strictEqual(passed.length, 2);
  assert.strictEqual(rejected.length, 0);
  assert.ok(passed[0].qa, 'qa attached');
  assert.strictEqual(passed[0].qa.generation, 0);
  assert.strictEqual(passed[0].qa.solver.agrees, true);
  assert.strictEqual(passed[0].qa.judge.verdict, 'accept');
  assert.strictEqual(report.passedCount, 2);
});

test('runQa rejects a lint-failing item without calling solver or judge', async () => {
  let solverCalled = false;
  const deps = {
    blindSolve: async () => { solverCalled = true; return { agrees: true }; },
    judgeQuestion: async () => ({ verdict: 'accept', scores: fullScores }),
  };
  const bad = goodQ({ options: [{ label: 'A', text: 'x' }, { label: 'B', text: 'x' }], correctAnswer: 'A' });
  const { passed, rejected } = await qa.runQa([bad], { topic: 'linked lists' }, deps);
  assert.strictEqual(passed.length, 0);
  assert.strictEqual(rejected.length, 1);
  assert.strictEqual(solverCalled, false, 'solver must not run on lint-failed item');
});

test('runQa rejects a solver-mismatch item without calling judge', async () => {
  let judgeCalled = false;
  const deps = {
    blindSolve: async () => ({ agrees: false, valid: true, confidence: 0.9 }),
    judgeQuestion: async () => { judgeCalled = true; return { verdict: 'accept' }; },
  };
  const { passed, rejected } = await qa.runQa([goodQ()], { topic: 'linked lists' }, deps);
  assert.strictEqual(passed.length, 0);
  assert.strictEqual(rejected[0].reasons[0], 'solver_mismatch');
  assert.strictEqual(judgeCalled, false, 'judge must not run after solver mismatch');
});

test('runQa rejects a judge-failed item', async () => {
  const deps = {
    blindSolve: async () => ({ agrees: true, valid: true, confidence: 0.9 }),
    judgeQuestion: async () => ({ verdict: 'reject', reasons: ['judge_low_clarity'], scores: {} }),
  };
  const { passed, rejected } = await qa.runQa([goodQ()], { topic: 'linked lists' }, deps);
  assert.strictEqual(passed.length, 0);
  assert.strictEqual(rejected[0].reasons[0], 'judge_low_clarity');
});

test('runQa flags intra-set duplicates', async () => {
  const stem = 'Which structure offers constant average lookup by key value today here?';
  const questions = [goodQ({ questionText: stem }), goodQ({ questionText: stem })];
  const { passed, rejected } = await qa.runQa(questions, { topic: 'linked lists' }, passAllDeps());
  assert.strictEqual(passed.length, 1);
  assert.strictEqual(rejected.length, 1);
  assert.ok(rejected[0].reasons.includes('duplicate'));
});

// ── gate1Filter (shared D2C path) ─────────────────────────────────────────────

test('gate1Filter keeps clean questions and drops a malformed one', () => {
  const good1 = goodQ({ questionText: 'What is the average lookup cost of a hash map structure?' });
  const bad = goodQ({ options: [{ label: 'A', text: 'x' }, { label: 'B', text: 'x' }, { label: 'C', text: 'y' }, { label: 'D', text: 'z' }], correctAnswer: 'A' });
  const good2 = goodQ({ questionText: 'Describe the traversal cost of a singly linked list node chain.' });
  const { kept, dropped } = qa.gate1Filter([good1, bad, good2], { topic: 'linked lists' });
  assert.strictEqual(kept.length, 2);
  assert.strictEqual(dropped.length, 1);
  assert.strictEqual(dropped[0].reason, 'duplicate_options');
});

test('gate1Filter appends to an existing kept set and dedups against it', () => {
  const stem = 'Which structure offers constant average lookup by key value in this case here?';
  const existing = [goodQ({ questionText: stem })];
  const dupe = goodQ({ questionText: stem });
  const fresh = goodQ({ questionText: 'What is the worst-case cost of a binary heap push operation?' });
  const { kept, dropped } = qa.gate1Filter([dupe, fresh], { existing });
  assert.strictEqual(kept.length, 2, 'existing + 1 fresh');
  assert.strictEqual(dropped.length, 1);
  assert.strictEqual(dropped[0].reason, 'duplicate');
});

test('gate1Filter does NOT drop on soft heuristics (length-bias, topic-echo)', () => {
  // A question that would trip length-bias/topic-echo but is structurally sound
  // must be KEPT by the shared path (behavior-preserving for D2C).
  const q = goodQ({
    options: [
      { label: 'A', text: 'This is the fully detailed textbook-worded correct answer option here now' },
      { label: 'B', text: 'Short' },
      { label: 'C', text: 'Brief' },
      { label: 'D', text: 'Tiny' },
    ],
    correctAnswer: 'A',
  });
  const { kept, dropped } = qa.gate1Filter([q], { topic: 'photosynthesis chlorophyll' });
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(dropped.length, 0);
});
