const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

delete require.cache[require.resolve('./UserObjective')];
const UserObjective = require('./UserObjective');

const baseDoc = () => ({
  userId: new mongoose.Types.ObjectId(),
  objectiveType: 'upskilling',
  timeline: '3_months',
  currentLevel: 'beginner',
  weeklyCommitHours: 5,
});

test('UserObjective: topicSelfRatings defaults to empty Map', () => {
  const doc = new UserObjective(baseDoc());
  const err = doc.validateSync();
  assert.strictEqual(err, undefined);
  assert.ok(doc.topicSelfRatings instanceof Map);
  assert.strictEqual(doc.topicSelfRatings.size, 0);
});

test('UserObjective: topicSelfRatings accepts valid proficiency levels', () => {
  const doc = new UserObjective({
    ...baseDoc(),
    topicSelfRatings: new Map([
      ['product-strategy', 'novice'],
      ['user-research', 'familiar'],
      ['roadmapping', 'proficient'],
      ['analytics', 'expert'],
    ]),
  });
  const err = doc.validateSync();
  assert.strictEqual(err, undefined);
  assert.strictEqual(doc.topicSelfRatings.get('product-strategy'), 'novice');
  assert.strictEqual(doc.topicSelfRatings.get('analytics'), 'expert');
});

test('UserObjective: topicSelfRatings rejects invalid proficiency level', () => {
  const doc = new UserObjective({
    ...baseDoc(),
    topicSelfRatings: new Map([['x', 'wizard']]),
  });
  const err = doc.validateSync();
  assert.ok(err, 'invalid enum should fail validation');
});

test('UserObjective: specificsCanonical defaults to empty subdoc', () => {
  const doc = new UserObjective(baseDoc());
  const err = doc.validateSync();
  assert.strictEqual(err, undefined);
  assert.ok(doc.specificsCanonical, 'subdoc should exist');
  assert.strictEqual(doc.specificsCanonical.examName, undefined);
});

test('UserObjective: specificsCanonical persists all six normalized fields', () => {
  const doc = new UserObjective({
    ...baseDoc(),
    specifics: { examName: 'jee', targetCompany: 'goog' },
    specificsCanonical: {
      examName: 'JEE Advanced',
      targetSkill: 'System Design',
      targetRole: 'Backend Engineer',
      targetCompany: 'Google',
      fromDomain: 'Frontend',
      toDomain: 'Backend',
    },
  });
  const err = doc.validateSync();
  assert.strictEqual(err, undefined);
  assert.strictEqual(doc.specificsCanonical.examName, 'JEE Advanced');
  assert.strictEqual(doc.specificsCanonical.targetCompany, 'Google');
  assert.strictEqual(doc.specificsCanonical.fromDomain, 'Frontend');
});

test('UserObjective: needsCalibration defaults to false', () => {
  const doc = new UserObjective(baseDoc());
  const err = doc.validateSync();
  assert.strictEqual(err, undefined);
  assert.strictEqual(doc.needsCalibration, false);
});

test('UserObjective: needsCalibration accepts true', () => {
  const doc = new UserObjective({ ...baseDoc(), needsCalibration: true });
  const err = doc.validateSync();
  assert.strictEqual(err, undefined);
  assert.strictEqual(doc.needsCalibration, true);
});

test('UserObjective: needsCalibration coerces or rejects non-boolean', () => {
  const doc = new UserObjective({ ...baseDoc(), needsCalibration: 'yes' });
  // Mongoose coerces strings to boolean — assert never raw string.
  doc.validateSync();
  assert.notStrictEqual(typeof doc.needsCalibration, 'string');
});
