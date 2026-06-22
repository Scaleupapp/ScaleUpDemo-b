'use strict';
const test = require('node:test');
const assert = require('node:assert');
const UserObjective = require('../../models/UserObjective');

// A minimal valid D2C objective (the shape onboarding creates) must be unaffected.
function baseD2C() {
  return new UserObjective({
    userId: '507f1f77bcf86cd799439011',
    objectiveType: 'upskilling',
    timeline: '3_months',
    currentLevel: 'beginner',
    weeklyCommitHours: 5,
  });
}

test('D2C objective with no institutionContext still validates (zero D2C impact)', () => {
  assert.strictEqual(baseD2C().validateSync(), undefined);
});

test('institutional objective with institutionContext validates', () => {
  const o = baseD2C();
  o.institutionContext = {
    institutionId: '507f1f77bcf86cd799439012',
    cohortId: '507f1f77bcf86cd799439013',
    templateId: '507f1f77bcf86cd799439014',
    locked: true,
  };
  assert.strictEqual(o.validateSync(), undefined);
  assert.strictEqual(o.institutionContext.locked, true);
});

test('$locals.skipInstitutionalDirectory is a settable per-document flag', () => {
  const o = baseD2C();
  o.$locals.skipInstitutionalDirectory = true;
  assert.strictEqual(o.$locals.skipInstitutionalDirectory, true);
});
