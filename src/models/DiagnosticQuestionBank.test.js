const test = require('node:test');
const assert = require('node:assert');

test('DiagnosticQuestionBank has required fields with defaults', () => {
  const Bank = require('./DiagnosticQuestionBank');
  const q = new Bank({
    canonicalCompetency: 'system design',
    difficulty: 'medium',
    questionText: 'What is X?',
    options: [
      { label: 'A', text: 'opt a' },
      { label: 'B', text: 'opt b', misconception: { tag: 'foo', explanation: 'bar' } },
    ],
    correctAnswer: 'A',
  });
  assert.strictEqual(q.source, 'live_generated');
  assert.strictEqual(q.status, 'active');
  assert.strictEqual(q.timesUsed, 0);
});

test('DiagnosticQuestionBank rejects invalid difficulty', () => {
  const Bank = require('./DiagnosticQuestionBank');
  const q = new Bank({
    canonicalCompetency: 'x',
    difficulty: 'super-hard',
    questionText: 'q',
    options: [],
    correctAnswer: 'A',
  });
  const err = q.validateSync();
  assert.ok(err.errors.difficulty);
});

test('DiagnosticQuestionBank rejects invalid source enum', () => {
  const Bank = require('./DiagnosticQuestionBank');
  const q = new Bank({
    canonicalCompetency: 'x',
    difficulty: 'easy',
    questionText: 'q',
    options: [],
    correctAnswer: 'A',
    source: 'bogus',
  });
  const err = q.validateSync();
  assert.ok(err.errors.source);
});

test('DiagnosticQuestionBank: defaults verificationStatus to pending', () => {
  const QB = require('./DiagnosticQuestionBank');
  const doc = new QB({
    canonicalCompetency: 'product-strategy',
    difficulty: 'easy',
    questionText: 'What is product strategy?',
    options: [
      { label: 'A', text: 'a' }, { label: 'B', text: 'b' },
      { label: 'C', text: 'c' }, { label: 'D', text: 'd' },
    ],
    correctAnswer: 'A',
  });
  const err = doc.validateSync();
  assert.strictEqual(err, undefined);
  assert.strictEqual(doc.verificationStatus, 'pending');
  assert.strictEqual(doc.isAnchor, false);
});

test('DiagnosticQuestionBank: rejects invalid verificationStatus', () => {
  const QB = require('./DiagnosticQuestionBank');
  const doc = new QB({
    canonicalCompetency: 'x',
    difficulty: 'easy',
    questionText: 'q',
    options: [
      { label: 'A', text: 'a' }, { label: 'B', text: 'b' },
      { label: 'C', text: 'c' }, { label: 'D', text: 'd' },
    ],
    correctAnswer: 'A',
    verificationStatus: 'made_up_status',
  });
  const err = doc.validateSync();
  assert.ok(err && err.errors.verificationStatus);
});

test('DiagnosticQuestionBank: accepts generationSource enum', () => {
  const QB = require('./DiagnosticQuestionBank');
  const doc = new QB({
    canonicalCompetency: 'x',
    difficulty: 'easy',
    questionText: 'q',
    options: [
      { label: 'A', text: 'a' }, { label: 'B', text: 'b' },
      { label: 'C', text: 'c' }, { label: 'D', text: 'd' },
    ],
    correctAnswer: 'A',
    generationSource: 'seed_batch',
    isAnchor: true,
  });
  const err = doc.validateSync();
  assert.strictEqual(err, undefined);
  assert.strictEqual(doc.isAnchor, true);
});
