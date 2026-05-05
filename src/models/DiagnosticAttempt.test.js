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

test('DiagnosticAttempt: insightsJson defaults to null', () => {
  delete require.cache[require.resolve('./DiagnosticAttempt')];
  if (mongoose.models.DiagnosticAttempt) delete mongoose.models.DiagnosticAttempt;
  if (mongoose.modelSchemas && mongoose.modelSchemas.DiagnosticAttempt) delete mongoose.modelSchemas.DiagnosticAttempt;
  const DA = require('./DiagnosticAttempt');
  const doc = new DA({
    userId: new mongoose.Types.ObjectId(),
    flowType: 'new_user',
  });
  doc.validateSync();
  assert.strictEqual(doc.insightsJson, null);
});

test('DiagnosticAttempt: planGenerationStatus defaults to pending', () => {
  delete require.cache[require.resolve('./DiagnosticAttempt')];
  if (mongoose.models.DiagnosticAttempt) delete mongoose.models.DiagnosticAttempt;
  if (mongoose.modelSchemas && mongoose.modelSchemas.DiagnosticAttempt) delete mongoose.modelSchemas.DiagnosticAttempt;
  const DA = require('./DiagnosticAttempt');
  const doc = new DA({
    userId: new mongoose.Types.ObjectId(),
    flowType: 'new_user',
  });
  doc.validateSync();
  assert.strictEqual(doc.planGenerationStatus, 'pending');
});

test('DiagnosticAttempt: planGenerationStatus rejects invalid value', () => {
  delete require.cache[require.resolve('./DiagnosticAttempt')];
  if (mongoose.models.DiagnosticAttempt) delete mongoose.models.DiagnosticAttempt;
  if (mongoose.modelSchemas && mongoose.modelSchemas.DiagnosticAttempt) delete mongoose.modelSchemas.DiagnosticAttempt;
  const DA = require('./DiagnosticAttempt');
  const doc = new DA({
    userId: new mongoose.Types.ObjectId(),
    flowType: 'new_user',
    planGenerationStatus: 'maybe',
  });
  const err = doc.validateSync();
  assert.ok(err && err.errors.planGenerationStatus);
});

test('DiagnosticAttempt: attemptType defaults to initial', () => {
  delete require.cache[require.resolve('./DiagnosticAttempt')];
  if (mongoose.models.DiagnosticAttempt) delete mongoose.models.DiagnosticAttempt;
  if (mongoose.modelSchemas && mongoose.modelSchemas.DiagnosticAttempt) delete mongoose.modelSchemas.DiagnosticAttempt;
  const DA = require('./DiagnosticAttempt');
  const doc = new DA({
    userId: new mongoose.Types.ObjectId(),
    flowType: 'new_user',
  });
  doc.validateSync();
  assert.strictEqual(doc.attemptType, 'initial');
});

test('DiagnosticAttempt: attemptType accepts recalibration with previousAttemptId', () => {
  delete require.cache[require.resolve('./DiagnosticAttempt')];
  if (mongoose.models.DiagnosticAttempt) delete mongoose.models.DiagnosticAttempt;
  if (mongoose.modelSchemas && mongoose.modelSchemas.DiagnosticAttempt) delete mongoose.modelSchemas.DiagnosticAttempt;
  const DA = require('./DiagnosticAttempt');
  const prev = new mongoose.Types.ObjectId();
  const doc = new DA({
    userId: new mongoose.Types.ObjectId(),
    flowType: 'existing_user_tune',
    attemptType: 'recalibration',
    previousAttemptId: prev,
  });
  const err = doc.validateSync();
  assert.strictEqual(err, undefined);
  assert.strictEqual(String(doc.previousAttemptId), String(prev));
});

test('DiagnosticAttempt: attemptType rejects invalid enum value', () => {
  delete require.cache[require.resolve('./DiagnosticAttempt')];
  if (mongoose.models.DiagnosticAttempt) delete mongoose.models.DiagnosticAttempt;
  if (mongoose.modelSchemas && mongoose.modelSchemas.DiagnosticAttempt) delete mongoose.modelSchemas.DiagnosticAttempt;
  const DA = require('./DiagnosticAttempt');
  const doc = new DA({
    userId: new mongoose.Types.ObjectId(),
    flowType: 'new_user',
    attemptType: 'practice',
  });
  const err = doc.validateSync();
  assert.ok(err && err.errors.attemptType);
});
