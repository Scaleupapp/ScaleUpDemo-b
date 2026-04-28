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
