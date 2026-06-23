'use strict';
const test = require('node:test');
const assert = require('node:assert');
const CohortRollup = require('../../models/CohortRollup');

test('valid CohortRollup passes validateSync', () => {
  const r = new CohortRollup({
    institutionId: '507f1f77bcf86cd799439011',
    cohortId: '507f1f77bcf86cd799439012',
    counts: { assigned: 30, started: 20, submitted: 18, graded: 18 },
    avgScore: 64,
    byCompetency: [{ name: 'DSA', avgScore: 61, n: 18 }],
  });
  assert.strictEqual(r.validateSync(), undefined);
});

test('CohortRollup requires institutionId + cohortId', () => {
  const err = new CohortRollup({}).validateSync();
  assert.ok(err.errors.institutionId && err.errors.cohortId);
});
