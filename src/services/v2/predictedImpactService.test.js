'use strict';

const { test } = require('node:test');
const assert = require('assert');

const { predictTaskImpact, _internal } = require('./predictedImpactService');

test('predictTaskImpact: watch on weak topic → meaningful gain', () => {
  const r = predictTaskImpact({
    taskType: 'watch',
    primaryTopic: 'dp',
    currentMastery: 30,
    difficulty: 3,
  });
  assert.strictEqual(r.expectedFrom, 30);
  assert.ok(r.expectedGain >= 2);
  assert.ok(r.expectedTo > r.expectedFrom);
  assert.match(r.whyText, /closes a major gap/i);
});

test('predictTaskImpact: harder difficulty → larger gain', () => {
  const easy = predictTaskImpact({ taskType: 'watch', primaryTopic: 'os', currentMastery: 40, difficulty: 1 });
  const hard = predictTaskImpact({ taskType: 'watch', primaryTopic: 'os', currentMastery: 40, difficulty: 5 });
  assert.ok(hard.expectedGain >= easy.expectedGain,
    `expected hard gain (${hard.expectedGain}) >= easy gain (${easy.expectedGain})`);
});

test('predictTaskImpact: diminishing returns near ceiling', () => {
  const high = predictTaskImpact({ taskType: 'watch', primaryTopic: 'os', currentMastery: 90, difficulty: 3 });
  assert.ok(high.expectedGain < 6, `expected small gain near ceiling, got ${high.expectedGain}`);
  assert.match(high.whyText, /maintenance/i);
});

test('predictTaskImpact: never exceeds ceiling', () => {
  const r = predictTaskImpact({ taskType: 'watch', primaryTopic: 'os', currentMastery: 94, difficulty: 5 });
  assert.ok(r.expectedTo <= _internal.MASTERY_CEILING);
});

test('predictTaskImpact: unknown taskType falls back to watch', () => {
  const r = predictTaskImpact({ taskType: 'mystery', primaryTopic: 'x', currentMastery: 50, difficulty: 3 });
  assert.ok(r.expectedGain >= 1);
});

test('predictTaskImpact: mock_exam has highest baseline gain', () => {
  const mock = predictTaskImpact({ taskType: 'mock_exam', primaryTopic: 'x', currentMastery: 50, difficulty: 3 });
  const reflection = predictTaskImpact({ taskType: 'reflection', primaryTopic: 'x', currentMastery: 50, difficulty: 3 });
  assert.ok(mock.expectedGain > reflection.expectedGain);
});
