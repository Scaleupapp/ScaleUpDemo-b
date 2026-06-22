'use strict';
const test = require('node:test');
const assert = require('node:assert');
const ObjectiveTemplate = require('../../models/ObjectiveTemplate');

test('valid ObjectiveTemplate passes validateSync', () => {
  const t = new ObjectiveTemplate({
    institutionId: '507f1f77bcf86cd799439011',
    label: 'Software Placement — Final Year 2026',
    objectiveType: 'interview_preparation',
    specifics: { targetRole: 'Software Engineer' },
    competencies: [{ name: 'DSA', weight: 9, category: 'core' }, { name: 'System Design', weight: 7, category: 'advanced' }],
    capabilityTrack: 'software',
    createdBy: '507f1f77bcf86cd799439012',
  });
  assert.strictEqual(t.validateSync(), undefined);
  assert.strictEqual(t.status, 'active'); // default
});

test('ObjectiveTemplate requires institutionId, label, objectiveType', () => {
  const t = new ObjectiveTemplate({ competencies: [] });
  const err = t.validateSync();
  assert.ok(err.errors.institutionId);
  assert.ok(err.errors.label);
  assert.ok(err.errors.objectiveType);
});

test('ObjectiveTemplate rejects an invalid objectiveType', () => {
  const t = new ObjectiveTemplate({ institutionId: '507f1f77bcf86cd799439011', label: 'X', objectiveType: 'not_a_type' });
  const err = t.validateSync();
  assert.ok(err.errors.objectiveType);
});

test('ObjectiveTemplate rejects an invalid capabilityTrack', () => {
  const t = new ObjectiveTemplate({ institutionId: '507f1f77bcf86cd799439011', label: 'X', objectiveType: 'upskilling', capabilityTrack: 'nope' });
  const err = t.validateSync();
  assert.ok(err.errors.capabilityTrack);
});
