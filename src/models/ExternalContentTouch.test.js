const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

delete require.cache[require.resolve('./ExternalContentTouch')];
const ExternalContentTouch = require('./ExternalContentTouch');

test('ExternalContentTouch: validates with required fields', () => {
  const doc = new ExternalContentTouch({
    userId: new mongoose.Types.ObjectId(),
    taskId: new mongoose.Types.ObjectId(),
    url: 'https://ocw.mit.edu/x',
    title: 'MIT OCW: X',
    source: 'mit',
    topicCanonicalName: 'react-hooks',
    selfRating: 4,
  });
  const err = doc.validateSync();
  assert.strictEqual(err, undefined);
  assert.strictEqual(doc.selfRating, 4);
  assert.ok(doc.completedAt instanceof Date);
});

test('ExternalContentTouch: rejects selfRating outside 1-5', () => {
  const doc = new ExternalContentTouch({
    userId: new mongoose.Types.ObjectId(),
    taskId: new mongoose.Types.ObjectId(),
    url: 'https://ocw.mit.edu/x',
    topicCanonicalName: 'react-hooks',
    selfRating: 99,
  });
  const err = doc.validateSync();
  assert.ok(err && err.errors.selfRating, 'selfRating range should be enforced');
});

test('ExternalContentTouch: requires url', () => {
  const doc = new ExternalContentTouch({
    userId: new mongoose.Types.ObjectId(),
    taskId: new mongoose.Types.ObjectId(),
    topicCanonicalName: 'react-hooks',
    selfRating: 3,
  });
  const err = doc.validateSync();
  assert.ok(err && err.errors.url, 'url required');
});
