const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

delete require.cache[require.resolve('./DiagnosticSyllabus')];
const DiagnosticSyllabus = require('./DiagnosticSyllabus');

const validDoc = () => ({
  userId: new mongoose.Types.ObjectId(),
  userObjectiveId: new mongoose.Types.ObjectId(),
  s3Key: 'syllabi/u123/abc.pdf',
  contentType: 'application/pdf',
  fileSizeBytes: 1024 * 512,
  contentHash: 'sha256-deadbeef',
});

test('DiagnosticSyllabus: defaults extractionStatus to pending', () => {
  const doc = new DiagnosticSyllabus(validDoc());
  const err = doc.validateSync();
  assert.strictEqual(err, undefined);
  assert.strictEqual(doc.extractionStatus, 'pending');
  assert.deepStrictEqual(doc.extractedTopics.toObject(), []);
  assert.deepStrictEqual(doc.derivedQuestionIds.toObject(), []);
});

test('DiagnosticSyllabus: requires userId', () => {
  const d = validDoc();
  delete d.userId;
  const doc = new DiagnosticSyllabus(d);
  const err = doc.validateSync();
  assert.ok(err && err.errors.userId);
});

test('DiagnosticSyllabus: requires contentHash', () => {
  const d = validDoc();
  delete d.contentHash;
  const doc = new DiagnosticSyllabus(d);
  const err = doc.validateSync();
  assert.ok(err && err.errors.contentHash);
});

test('DiagnosticSyllabus: rejects invalid extractionStatus', () => {
  const doc = new DiagnosticSyllabus({ ...validDoc(), extractionStatus: 'wat' });
  const err = doc.validateSync();
  assert.ok(err && err.errors.extractionStatus);
});

test('DiagnosticSyllabus: stores extractedTopics subdocs', () => {
  const doc = new DiagnosticSyllabus({
    ...validDoc(),
    extractionStatus: 'completed',
    extractedText: 'Chapter 5: Mechanics. Newtons laws...',
    pageCount: 22,
    extractedTopics: [
      { canonicalName: 'newtons-laws', displayName: 'Newton\'s Laws', description: 'Three laws.' },
      { canonicalName: 'work-energy', displayName: 'Work & Energy', description: 'WE theorem.' },
    ],
  });
  const err = doc.validateSync();
  assert.strictEqual(err, undefined);
  assert.strictEqual(doc.extractedTopics.length, 2);
  assert.strictEqual(doc.extractedTopics[0].canonicalName, 'newtons-laws');
});
