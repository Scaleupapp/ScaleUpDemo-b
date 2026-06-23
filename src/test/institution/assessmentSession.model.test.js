'use strict';
const test = require('node:test');
const assert = require('node:assert');
const AssessmentSession = require('../../models/AssessmentSession');

test('valid AssessmentSession passes validateSync with defaults', () => {
  const s = new AssessmentSession({
    assessmentId: '507f1f77bcf86cd799439011',
    institutionId: '507f1f77bcf86cd799439012',
    cohortId: '507f1f77bcf86cd799439013',
    userId: '507f1f77bcf86cd799439014',
    engine: { type: 'mcq' },
  });
  assert.strictEqual(s.validateSync(), undefined);
  assert.strictEqual(s.status, 'scheduled');
});

test('AssessmentSession requires assessmentId, userId, engine.type', () => {
  const s = new AssessmentSession({ institutionId: 'i', cohortId: 'c' });
  const err = s.validateSync();
  assert.ok(err.errors.assessmentId && err.errors.userId && err.errors['engine.type']);
});
