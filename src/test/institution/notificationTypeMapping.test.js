'use strict';
/**
 * Workstream B — Notification model enum + push→in-app type mapping for the two
 * new institution-assessment notification types.
 */
const test = require('node:test');
const assert = require('node:assert');
const Notification = require('../../models/Notification');
const notificationService = require('../../services/notificationService');

test('Notification.type enum includes assessment_assigned + assessment_results', () => {
  const enums = Notification.schema.path('type').enumValues;
  assert.ok(enums.includes('assessment_assigned'), 'assessment_assigned must be a valid type');
  assert.ok(enums.includes('assessment_results'), 'assessment_results must be a valid type');
});

test('_mapDataTypeToNotificationType maps the assessment push types to their in-app enum', () => {
  assert.strictEqual(notificationService._mapDataTypeToNotificationType('assessment_assigned'), 'assessment_assigned');
  assert.strictEqual(notificationService._mapDataTypeToNotificationType('assessment_results'), 'assessment_results');
});

test('_mapDataTypeToNotificationType keeps the journey_update fallback for unknown types', () => {
  assert.strictEqual(notificationService._mapDataTypeToNotificationType('something_new'), 'journey_update');
  // A previously-mapped type is unchanged (no regression).
  assert.strictEqual(notificationService._mapDataTypeToNotificationType('quiz_ready'), 'quiz_available');
});
