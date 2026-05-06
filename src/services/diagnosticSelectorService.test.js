const test = require('node:test');
const assert = require('node:assert');
const { _internal } = require('./diagnosticSelectorService');
const { initialDifficultyForRating, bandToScore, deriveBand } = _internal;

test('initialDifficultyForRating returns easy for novice/unsure', () => {
  assert.strictEqual(initialDifficultyForRating('novice'), 'easy');
  assert.strictEqual(initialDifficultyForRating('unsure'), 'easy');
});

test('initialDifficultyForRating returns easy or medium for familiar', () => {
  assert.match(initialDifficultyForRating('familiar'), /^(easy|medium)$/);
});

test('initialDifficultyForRating returns medium for proficient', () => {
  assert.strictEqual(initialDifficultyForRating('proficient'), 'medium');
});

test('initialDifficultyForRating returns medium or hard for expert', () => {
  assert.match(initialDifficultyForRating('expert'), /^(medium|hard)$/);
});

test('bandToScore: novice=25, familiar=50, proficient=70, expert=88', () => {
  assert.strictEqual(bandToScore('novice'), 25);
  assert.strictEqual(bandToScore('familiar'), 50);
  assert.strictEqual(bandToScore('proficient'), 70);
  assert.strictEqual(bandToScore('expert'), 88);
});

test('deriveBand maps performance to bands', () => {
  // 2/2 hard correct → expert
  assert.strictEqual(deriveBand({ easy: { correct: 0, wrong: 0 }, medium: { correct: 0, wrong: 0 }, hard: { correct: 2, wrong: 0 } }), 'expert');
  // 2/2 medium correct, no hard → proficient
  assert.strictEqual(deriveBand({ easy: { correct: 0, wrong: 0 }, medium: { correct: 2, wrong: 0 }, hard: { correct: 0, wrong: 0 } }), 'proficient');
  // 2/2 easy correct, no medium → familiar
  assert.strictEqual(deriveBand({ easy: { correct: 2, wrong: 0 }, medium: { correct: 0, wrong: 0 }, hard: { correct: 0, wrong: 0 } }), 'familiar');
  // 0/2 easy → novice
  assert.strictEqual(deriveBand({ easy: { correct: 0, wrong: 2 }, medium: { correct: 0, wrong: 0 }, hard: { correct: 0, wrong: 0 } }), 'novice');
});

test('selectNext: shouldStop true after 2 correct at same level', () => {
  const { selectNext } = require('./diagnosticSelectorService');
  const perf = { easy: { correct: 2, wrong: 0 }, medium: { correct: 0, wrong: 0 }, hard: { correct: 0, wrong: 0 } };
  const decision = selectNext({ perf, questionsAsked: 2, selfRating: 'novice', currentDifficulty: 'easy' });
  assert.strictEqual(decision.shouldStop, true);
});

test('selectNext: shouldStop true after 3 questions regardless', () => {
  const { selectNext } = require('./diagnosticSelectorService');
  const perf = { easy: { correct: 1, wrong: 1 }, medium: { correct: 1, wrong: 0 }, hard: { correct: 0, wrong: 0 } };
  const decision = selectNext({ perf, questionsAsked: 3, selfRating: 'familiar', currentDifficulty: 'medium' });
  assert.strictEqual(decision.shouldStop, true);
});

test('selectNext: harder difficulty after correct + fast answer', () => {
  const { selectNext } = require('./diagnosticSelectorService');
  const perf = { easy: { correct: 1, wrong: 0 }, medium: { correct: 0, wrong: 0 }, hard: { correct: 0, wrong: 0 } };
  const decision = selectNext({ perf, questionsAsked: 1, selfRating: 'novice', currentDifficulty: 'easy', lastAnswer: { correct: true, fast: true } });
  assert.strictEqual(decision.nextDifficulty, 'medium');
});

test('selectNext: same difficulty after correct + normal speed', () => {
  const { selectNext } = require('./diagnosticSelectorService');
  const perf = { easy: { correct: 1, wrong: 0 }, medium: { correct: 0, wrong: 0 }, hard: { correct: 0, wrong: 0 } };
  const decision = selectNext({ perf, questionsAsked: 1, selfRating: 'novice', currentDifficulty: 'easy', lastAnswer: { correct: true, fast: false } });
  assert.strictEqual(decision.nextDifficulty, 'easy');
});

test('selectNext: easier difficulty after wrong answer', () => {
  const { selectNext } = require('./diagnosticSelectorService');
  const perf = { easy: { correct: 0, wrong: 0 }, medium: { correct: 0, wrong: 1 }, hard: { correct: 0, wrong: 0 } };
  const decision = selectNext({ perf, questionsAsked: 1, selfRating: 'familiar', currentDifficulty: 'medium', lastAnswer: { correct: false, fast: false } });
  assert.strictEqual(decision.nextDifficulty, 'easy');
});

test('selectNext: clamps at hard (cant go past hard)', () => {
  const { selectNext } = require('./diagnosticSelectorService');
  const perf = { easy: { correct: 0, wrong: 0 }, medium: { correct: 0, wrong: 0 }, hard: { correct: 1, wrong: 0 } };
  const decision = selectNext({ perf, questionsAsked: 1, selfRating: 'expert', currentDifficulty: 'hard', lastAnswer: { correct: true, fast: true } });
  assert.strictEqual(decision.nextDifficulty, 'hard');
});

test('selectNext: clamps at easy (cant go below easy)', () => {
  const { selectNext } = require('./diagnosticSelectorService');
  const perf = { easy: { correct: 0, wrong: 1 }, medium: { correct: 0, wrong: 0 }, hard: { correct: 0, wrong: 0 } };
  const decision = selectNext({ perf, questionsAsked: 1, selfRating: 'novice', currentDifficulty: 'easy', lastAnswer: { correct: false, fast: false } });
  assert.strictEqual(decision.nextDifficulty, 'easy');
});

test('selectNext: deterministic rng param produces deterministic output', () => {
  const { selectNext } = require('./diagnosticSelectorService');
  const perf = { easy: { correct: 0, wrong: 0 }, medium: { correct: 0, wrong: 0 }, hard: { correct: 0, wrong: 0 } };
  // rng always returns 0.1 → familiar maps to 'easy' (0.1 < 0.5)
  const rng = () => 0.1;
  const d1 = selectNext({ perf, questionsAsked: 0, selfRating: 'familiar', currentDifficulty: undefined, lastAnswer: null, rng });
  const d2 = selectNext({ perf, questionsAsked: 0, selfRating: 'familiar', currentDifficulty: undefined, lastAnswer: null, rng });
  assert.strictEqual(d1.nextDifficulty, 'easy');
  assert.strictEqual(d1.nextDifficulty, d2.nextDifficulty);
});

// ---------------------------------------------------------------------------
// Path C question planning (Plan 3a, Task 1)
// ---------------------------------------------------------------------------

const { questionPlanForTopic, totalQuestionsForAttempt, applyCompanyWeights } = require('./diagnosticSelectorService');

test('questionPlanForTopic: novice → 2 easy', () => {
  const plan = questionPlanForTopic('product-strategy', 'novice');
  assert.strictEqual(plan.length, 2);
  for (const q of plan) assert.strictEqual(q.difficulty, 'easy');
});

test('questionPlanForTopic: familiar → 1 easy + 1 medium + 1 hard', () => {
  const plan = questionPlanForTopic('product-strategy', 'familiar');
  assert.strictEqual(plan.length, 3);
  const counts = plan.reduce((m, q) => { m[q.difficulty] = (m[q.difficulty] || 0) + 1; return m; }, {});
  assert.strictEqual(counts.easy, 1);
  assert.strictEqual(counts.medium, 1);
  assert.strictEqual(counts.hard, 1);
});

test('questionPlanForTopic: proficient → 1 medium + 2 hard', () => {
  const plan = questionPlanForTopic('x', 'proficient');
  assert.strictEqual(plan.length, 3);
  const counts = plan.reduce((m, q) => { m[q.difficulty] = (m[q.difficulty] || 0) + 1; return m; }, {});
  assert.strictEqual(counts.medium, 1);
  assert.strictEqual(counts.hard, 2);
});

test('questionPlanForTopic: expert → 3 hard with scenario flag', () => {
  const plan = questionPlanForTopic('x', 'expert');
  assert.strictEqual(plan.length, 3);
  for (const q of plan) {
    assert.strictEqual(q.difficulty, 'hard');
  }
  assert.ok(plan.some(q => q.requiresScenario), 'at least one expert question should require scenario');
});

test('totalQuestionsForAttempt: sums per-topic plans', () => {
  const ratings = new Map([
    ['product-strategy', 'familiar'],
    ['user-research', 'novice'],
    ['roadmapping', 'proficient'],
  ]);
  const total = totalQuestionsForAttempt(ratings);
  // familiar=3 + novice=2 + proficient=3 = 8
  assert.strictEqual(total, 8);
});

test('questionPlanForTopic: each entry carries canonicalTopic', () => {
  const plan = questionPlanForTopic('user-research', 'familiar');
  for (const q of plan) {
    assert.strictEqual(q.canonicalTopic, 'user-research');
  }
});

test('questionPlanForTopic: throws on unknown rating', () => {
  assert.throws(() => questionPlanForTopic('x', 'wizard'), /Unknown rating/);
});

test('applyCompanyWeights: high weight (>=1.5) bumps difficulty band', () => {
  const plan = questionPlanForTopic('product-strategy', 'familiar'); // easy/medium/hard
  const weighted = applyCompanyWeights(plan, { 'product-strategy': 2.0 });
  // easy → medium, medium → hard, hard stays hard
  assert.strictEqual(weighted[0].difficulty, 'medium');
  assert.strictEqual(weighted[1].difficulty, 'hard');
  assert.strictEqual(weighted[2].difficulty, 'hard');
});

test('applyCompanyWeights: low weight (<=0.5) drops one question', () => {
  const plan = questionPlanForTopic('product-strategy', 'familiar'); // 3 entries
  const weighted = applyCompanyWeights(plan, new Map([['product-strategy', 0.3]]));
  assert.strictEqual(weighted.length, 2);
});

test('applyCompanyWeights: missing weight is a noop', () => {
  const plan = questionPlanForTopic('product-strategy', 'novice');
  const weighted = applyCompanyWeights(plan, { 'other-topic': 2.0 });
  assert.deepStrictEqual(weighted, plan);
});

test('voiceEligibleTopics: interview_prep includes behavioral', () => {
  delete require.cache[require.resolve('./diagnosticSelectorService')];
  const { voiceEligibleTopics } = require('./diagnosticSelectorService');
  const eligible = voiceEligibleTopics('interview_preparation', ['behavioral', 'system-design']);
  assert.ok(eligible.includes('behavioral'));
  assert.ok(!eligible.includes('system-design'));
});

test('voiceEligibleTopics: upskilling includes stakeholder/leadership topics', () => {
  delete require.cache[require.resolve('./diagnosticSelectorService')];
  const { voiceEligibleTopics } = require('./diagnosticSelectorService');
  const eligible = voiceEligibleTopics('upskilling', ['stakeholder-management', 'cross-functional-leadership', 'sql-fundamentals']);
  assert.ok(eligible.includes('stakeholder-management'));
  assert.ok(eligible.includes('cross-functional-leadership'));
  assert.ok(!eligible.includes('sql-fundamentals'));
});

test('voiceEligibleTopics: exam_preparation returns empty', () => {
  delete require.cache[require.resolve('./diagnosticSelectorService')];
  const { voiceEligibleTopics } = require('./diagnosticSelectorService');
  assert.deepStrictEqual(voiceEligibleTopics('exam_preparation', ['quant', 'verbal']), []);
});

test('isStrictTimerObjective: true for exam_preparation, false for others', () => {
  delete require.cache[require.resolve('./diagnosticSelectorService')];
  const { isStrictTimerObjective } = require('./diagnosticSelectorService');
  assert.strictEqual(isStrictTimerObjective('exam_preparation'), true);
  assert.strictEqual(isStrictTimerObjective('upskilling'), false);
});
