'use strict';
/**
 * Tests for src/models/AssessmentSource.js — validateSync only, no DB.
 */
const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const AssessmentSource = require('../../models/AssessmentSource');

const INSTITUTION_ID = new mongoose.Types.ObjectId();
const USER_ID = new mongoose.Types.ObjectId();

test('AssessmentSource: valid document passes validateSync', () => {
  const doc = new AssessmentSource({
    institutionId: INSTITUTION_ID,
    uploadedBy: USER_ID,
    filename: 'syllabus.pdf',
    mimeType: 'application/pdf',
  });
  const err = doc.validateSync();
  assert.strictEqual(err, undefined, `validateSync should pass: ${err}`);
});

test('AssessmentSource: missing institutionId fails validateSync', () => {
  const doc = new AssessmentSource({
    uploadedBy: USER_ID,
    filename: 'syllabus.pdf',
    mimeType: 'application/pdf',
  });
  const err = doc.validateSync();
  assert.ok(err, 'should fail when institutionId missing');
  assert.ok(err.errors.institutionId, 'error should be on institutionId');
});

test('AssessmentSource: missing uploadedBy fails validateSync', () => {
  const doc = new AssessmentSource({
    institutionId: INSTITUTION_ID,
    filename: 'syllabus.pdf',
    mimeType: 'application/pdf',
  });
  const err = doc.validateSync();
  assert.ok(err, 'should fail when uploadedBy missing');
  assert.ok(err.errors.uploadedBy, 'error should be on uploadedBy');
});

test('AssessmentSource: missing filename fails validateSync', () => {
  const doc = new AssessmentSource({
    institutionId: INSTITUTION_ID,
    uploadedBy: USER_ID,
    mimeType: 'application/pdf',
  });
  const err = doc.validateSync();
  assert.ok(err, 'should fail when filename missing');
  assert.ok(err.errors.filename, 'error should be on filename');
});

test('AssessmentSource: missing mimeType fails validateSync', () => {
  const doc = new AssessmentSource({
    institutionId: INSTITUTION_ID,
    uploadedBy: USER_ID,
    filename: 'notes.png',
  });
  const err = doc.validateSync();
  assert.ok(err, 'should fail when mimeType missing');
  assert.ok(err.errors.mimeType, 'error should be on mimeType');
});

test('AssessmentSource: status defaults to "uploaded"', () => {
  const doc = new AssessmentSource({
    institutionId: INSTITUTION_ID,
    uploadedBy: USER_ID,
    filename: 'file.pdf',
    mimeType: 'application/pdf',
  });
  assert.strictEqual(doc.status, 'uploaded');
});

test('AssessmentSource: invalid status fails validateSync', () => {
  const doc = new AssessmentSource({
    institutionId: INSTITUTION_ID,
    uploadedBy: USER_ID,
    filename: 'file.pdf',
    mimeType: 'application/pdf',
    status: 'processing', // not in enum
  });
  const err = doc.validateSync();
  assert.ok(err, 'should fail with invalid status');
  assert.ok(err.errors.status, 'error should be on status');
});

test('AssessmentSource: valid statuses pass validateSync', () => {
  for (const status of ['uploaded', 'extracting', 'ready', 'failed']) {
    const doc = new AssessmentSource({
      institutionId: INSTITUTION_ID,
      uploadedBy: USER_ID,
      filename: 'file.pdf',
      mimeType: 'application/pdf',
      status,
    });
    const err = doc.validateSync();
    assert.strictEqual(err, undefined, `status "${status}" should be valid`);
  }
});

test('AssessmentSource: optional cohortId, s3Key, extractedText, error fields accepted', () => {
  const doc = new AssessmentSource({
    institutionId: INSTITUTION_ID,
    uploadedBy: USER_ID,
    filename: 'notes.pdf',
    mimeType: 'application/pdf',
    cohortId: new mongoose.Types.ObjectId(),
    s3Key: 'assessment-sources/abc/123',
    extractedText: 'Chapter 1: Introduction',
    error: 'parse error',
  });
  const err = doc.validateSync();
  assert.strictEqual(err, undefined, `validateSync should pass: ${err}`);
});

test('AssessmentSource: extractedTopics array with name field accepted', () => {
  const doc = new AssessmentSource({
    institutionId: INSTITUTION_ID,
    uploadedBy: USER_ID,
    filename: 'notes.pdf',
    mimeType: 'application/pdf',
    extractedTopics: [{ name: 'Data Structures' }, { name: 'Algorithms' }],
  });
  const err = doc.validateSync();
  assert.strictEqual(err, undefined, `validateSync should pass: ${err}`);
  assert.strictEqual(doc.extractedTopics.length, 2);
  assert.strictEqual(doc.extractedTopics[0].name, 'Data Structures');
});
