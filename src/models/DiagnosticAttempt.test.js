const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

test('DiagnosticAttempt schema has required fields and defaults', () => {
  const DiagnosticAttempt = require('./DiagnosticAttempt');
  const attempt = new DiagnosticAttempt({
    userId: new mongoose.Types.ObjectId(),
    flowType: 'new_user',
  });
  assert.strictEqual(attempt.status, 'in_progress');
  assert.deepStrictEqual(attempt.answers.toObject ? attempt.answers.toObject() : Array.from(attempt.answers), []);
  assert.ok(attempt.startedAt instanceof Date);
});

test('DiagnosticAttempt rejects invalid status enum', () => {
  const DiagnosticAttempt = require('./DiagnosticAttempt');
  const attempt = new DiagnosticAttempt({
    userId: new mongoose.Types.ObjectId(),
    flowType: 'new_user',
    status: 'bogus',
  });
  const err = attempt.validateSync();
  assert.ok(err);
  assert.ok(err.errors.status);
});

test('DiagnosticAttempt rejects invalid flowType enum', () => {
  const DiagnosticAttempt = require('./DiagnosticAttempt');
  const attempt = new DiagnosticAttempt({
    userId: new mongoose.Types.ObjectId(),
    flowType: 'bogus',
  });
  const err = attempt.validateSync();
  assert.ok(err);
  assert.ok(err.errors.flowType);
});
