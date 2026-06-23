'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Assessment = require('../../models/Assessment');

test('valid mcq Assessment passes validateSync', () => {
  const a = new Assessment({
    institutionId: '507f1f77bcf86cd799439011',
    cohortId: '507f1f77bcf86cd799439012',
    type: 'mcq',
    title: 'Aptitude Round 1',
    config: { mcq: { totalQuestions: 20, durationSeconds: 1800, assessmentType: 'exam_style', questions: [] } },
    opensAt: new Date(), closesAt: new Date(Date.now() + 86400000),
    createdBy: '507f1f77bcf86cd799439013',
  });
  assert.strictEqual(a.validateSync(), undefined);
  assert.strictEqual(a.status, 'draft');
  assert.strictEqual(a.integrityRequired, true);
});

test('Assessment requires institutionId, cohortId, type, title', () => {
  const a = new Assessment({});
  const err = a.validateSync();
  assert.ok(err.errors.institutionId && err.errors.cohortId && err.errors.type && err.errors.title);
});

test('Assessment rejects an unknown type', () => {
  const a = new Assessment({ institutionId: 'i', cohortId: 'c', type: 'essay', title: 'x' });
  // ObjectId cast aside, the enum on type must reject 'essay'
  const err = a.validateSync();
  assert.ok(err.errors.type);
});
