const test = require('node:test');
const assert = require('node:assert');
const calibration = require('./calibration');

test('scoreToBand: novice boundary', () => {
  assert.strictEqual(calibration.scoreToBand(0), 'Novice');
  assert.strictEqual(calibration.scoreToBand(29.99), 'Novice');
  assert.strictEqual(calibration.scoreToBand(30), 'Familiar');
});

test('scoreToBand: familiar boundary', () => {
  assert.strictEqual(calibration.scoreToBand(54.99), 'Familiar');
  assert.strictEqual(calibration.scoreToBand(55), 'Proficient');
});

test('scoreToBand: proficient boundary', () => {
  assert.strictEqual(calibration.scoreToBand(79.99), 'Proficient');
  assert.strictEqual(calibration.scoreToBand(80), 'Expert');
});

test('scoreToBand: expert ceiling', () => {
  assert.strictEqual(calibration.scoreToBand(100), 'Expert');
});

test('scoreToBand: clamps below 0 and above 100', () => {
  assert.strictEqual(calibration.scoreToBand(-5), 'Novice');
  assert.strictEqual(calibration.scoreToBand(150), 'Expert');
});

test('selfRatingToMidpoint: every band', () => {
  assert.strictEqual(calibration.selfRatingToMidpoint('Novice'), 15);
  assert.strictEqual(calibration.selfRatingToMidpoint('Familiar'), 42);
  assert.strictEqual(calibration.selfRatingToMidpoint('Proficient'), 67);
  assert.strictEqual(calibration.selfRatingToMidpoint('Expert'), 90);
});

test('selfRatingToMidpoint: case-insensitive', () => {
  assert.strictEqual(calibration.selfRatingToMidpoint('novice'), 15);
  assert.strictEqual(calibration.selfRatingToMidpoint('PROFICIENT'), 67);
});

test('selfRatingToMidpoint: throws on unknown band', () => {
  assert.throws(() => calibration.selfRatingToMidpoint('Master'), /unknown self-rating/i);
});

test('calibrationDelta: measured - selfRatedMidpoint', () => {
  assert.strictEqual(calibration.calibrationDelta(70, 'Familiar'), 28);
  assert.strictEqual(calibration.calibrationDelta(50, 'Expert'), -40);
});

test('calibrationClass: well-calibrated band', () => {
  assert.strictEqual(calibration.calibrationClass(0), 'well-calibrated');
  assert.strictEqual(calibration.calibrationClass(15), 'well-calibrated');
  assert.strictEqual(calibration.calibrationClass(-15), 'well-calibrated');
});

test('calibrationClass: overestimates when delta < -15', () => {
  assert.strictEqual(calibration.calibrationClass(-16), 'overestimates');
  assert.strictEqual(calibration.calibrationClass(-50), 'overestimates');
});

test('calibrationClass: undersells when delta > +15', () => {
  assert.strictEqual(calibration.calibrationClass(16), 'undersells');
  assert.strictEqual(calibration.calibrationClass(40), 'undersells');
});

test('classifyTopic: composes all three', () => {
  const result = calibration.classifyTopic({ measuredScore: 30, selfRating: 'Expert' });
  assert.strictEqual(result.measuredBand, 'Familiar');
  assert.strictEqual(result.selfRatedMidpoint, 90);
  assert.strictEqual(result.calibrationDelta, -60);
  assert.strictEqual(result.calibrationClass, 'overestimates');
});

test('summarizeAttempt: counts well-calibrated topics', () => {
  const summary = calibration.summarizeAttempt([
    { canonicalName: 'a', measuredScore: 70, selfRating: 'Proficient' },
    { canonicalName: 'b', measuredScore: 30, selfRating: 'Expert' },
    { canonicalName: 'c', measuredScore: 80, selfRating: 'Novice' },
    { canonicalName: 'd', measuredScore: 50, selfRating: 'Familiar' },
  ]);
  assert.strictEqual(summary.totalTopics, 4);
  assert.strictEqual(summary.wellCalibratedCount, 2);
  assert.strictEqual(summary.overestimatesCount, 1);
  assert.strictEqual(summary.undersellsCount, 1);
  assert.deepStrictEqual(summary.dominantPattern, 'mixed');
});

test('summarizeAttempt: dominant overestimate pattern', () => {
  const summary = calibration.summarizeAttempt([
    { canonicalName: 'a', measuredScore: 10, selfRating: 'Expert' },
    { canonicalName: 'b', measuredScore: 20, selfRating: 'Expert' },
    { canonicalName: 'c', measuredScore: 70, selfRating: 'Proficient' },
  ]);
  assert.strictEqual(summary.dominantPattern, 'overestimates');
});
