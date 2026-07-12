'use strict';

const { test } = require('node:test');
const assert = require('assert');
const mongoose = require('mongoose');

const InterviewProgram = require('./InterviewProgram');

test('InterviewProgram: minimal valid doc passes validateSync with defaults', () => {
  const doc = new InterviewProgram({
    userId: new mongoose.Types.ObjectId(),
    targetRole: 'Product Manager',
  });
  assert.strictEqual(doc.validateSync(), undefined);
  assert.strictEqual(doc.status, 'active');
  assert.strictEqual(doc.weeks, 4);
  assert.deepStrictEqual(doc.sessionIds, []);
  assert.deepStrictEqual(doc.focusHistory, []);
});

test('InterviewProgram: missing userId fails validation', () => {
  const doc = new InterviewProgram({ targetRole: 'PM' });
  const err = doc.validateSync();
  assert.ok(err);
  assert.ok(err.errors.userId);
});

test('InterviewProgram: rejects unknown status', () => {
  const doc = new InterviewProgram({
    userId: new mongoose.Types.ObjectId(),
    status: 'paused',
  });
  const err = doc.validateSync();
  assert.ok(err);
  assert.ok(err.errors.status);
});

test('InterviewProgram: focusHistory entry requires dimension', () => {
  const doc = new InterviewProgram({
    userId: new mongoose.Types.ObjectId(),
    focusHistory: [{ at: new Date(), reason: 'lowest score' }],
  });
  const err = doc.validateSync();
  assert.ok(err);
  assert.ok(err.errors['focusHistory.0.dimension']);
});

test('InterviewProgram: accepts a fully populated program', () => {
  const sessionId = new mongoose.Types.ObjectId();
  const doc = new InterviewProgram({
    userId: new mongoose.Types.ObjectId(),
    targetRole: 'SWE',
    targetCompany: 'Acme',
    driveDate: new Date('2026-09-01'),
    weeks: 6,
    sessionIds: [sessionId],
    focusHistory: [{ at: new Date(), dimension: 'structure', reason: 'lowest score', sessionId }],
  });
  assert.strictEqual(doc.validateSync(), undefined);
});
