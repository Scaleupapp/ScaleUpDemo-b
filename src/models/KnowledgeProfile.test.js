const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

test('KnowledgeProfile.topicMastery accepts selfRating and calibrationAtBaseline', () => {
  const KP = require('./KnowledgeProfile');
  const kp = new KP({
    userId: new mongoose.Types.ObjectId(),
    topicMastery: [{
      topic: 'foo',
      score: 50,
      selfRating: 'familiar',
      calibrationAtBaseline: { delta: -1, capturedAt: new Date() },
    }],
  });
  const err = kp.validateSync();
  assert.strictEqual(err, undefined, err && err.message);
  assert.strictEqual(kp.topicMastery[0].selfRating, 'familiar');
  assert.strictEqual(kp.topicMastery[0].calibrationAtBaseline.delta, -1);
});

test('KnowledgeProfile.topicMastery rejects invalid selfRating enum', () => {
  const KP = require('./KnowledgeProfile');
  const kp = new KP({
    userId: new mongoose.Types.ObjectId(),
    topicMastery: [{ topic: 'foo', selfRating: 'bogus' }],
  });
  const err = kp.validateSync();
  assert.ok(err);
  assert.ok(err.errors['topicMastery.0.selfRating']);
});

test('KnowledgeProfile.topicMastery still works without selfRating (backward compat)', () => {
  const KP = require('./KnowledgeProfile');
  const kp = new KP({
    userId: new mongoose.Types.ObjectId(),
    topicMastery: [{ topic: 'foo', score: 70 }],
  });
  const err = kp.validateSync();
  assert.strictEqual(err, undefined);
  assert.strictEqual(kp.topicMastery[0].selfRating, undefined);
});
