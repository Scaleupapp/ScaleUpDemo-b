'use strict';

const test = require('node:test');
const assert = require('node:assert');
const CapstoneGenerationRequest = require('./capstoneGenerationRequest.model');

/**
 * Ownership-mode validation lives in a pre('validate') hook, which
 * validateSync() does NOT run (Mongoose only runs synchronous field
 * validators under validateSync — hooks require the async validate()
 * pipeline). So these use await doc.validate() / assert.rejects, which
 * exercises the full validation pipeline without needing a live DB
 * connection (validate() alone never talks to Mongo).
 */

function base(overrides = {}) {
  return new CapstoneGenerationRequest({
    role_track: 'swe',
    difficulty: 'medium',
    language: 'python',
    ...overrides,
  });
}

test('user-owned (D2C) request validates: user_id set, institution_id unset', async () => {
  const doc = base({ user_id: '507f1f77bcf86cd799439011' });
  await assert.doesNotReject(doc.validate());
});

test('institution-owned request validates: institution_id set, user_id unset', async () => {
  const doc = base({ institution_id: '507f1f77bcf86cd799439012' });
  await assert.doesNotReject(doc.validate());
});

test('institution-owned request keeps user_id unset even with cohort/assessment/requestedBy enrichment set', async () => {
  const doc = base({
    institution_id: '507f1f77bcf86cd799439012',
    cohort_id: '507f1f77bcf86cd799439013',
    assessment_id: '507f1f77bcf86cd799439014',
    requested_by_institution_user: '507f1f77bcf86cd799439015',
  });
  await assert.doesNotReject(doc.validate());
  assert.strictEqual(doc.user_id, undefined);
});

test('neither user_id nor institution_id set -> ValidationError with the ownership message', async () => {
  const doc = base();
  await assert.rejects(doc.validate(), (err) => {
    assert.strictEqual(err.name, 'ValidationError');
    assert.match(
      err.errors.user_id.message,
      /a generation request must be owned by either a user \(D2C\) or an institution/
    );
    return true;
  });
});

test('both user_id and institution_id set -> ValidationError with the ownership message', async () => {
  const doc = base({
    user_id: '507f1f77bcf86cd799439011',
    institution_id: '507f1f77bcf86cd799439012',
  });
  await assert.rejects(doc.validate(), (err) => {
    assert.strictEqual(err.name, 'ValidationError');
    assert.match(
      err.errors.user_id.message,
      /a generation request must be owned by either a user \(D2C\) or an institution/
    );
    return true;
  });
});

test('user_id is no longer required:true at the schema level (institution mode must be able to omit it)', () => {
  const path = CapstoneGenerationRequest.schema.path('user_id');
  assert.ok(!path.isRequired, 'user_id must not be schema-required — institution-owned requests never set it');
});
