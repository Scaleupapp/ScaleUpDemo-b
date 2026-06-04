// src/test/v2/compassConversation.cards.test.js
'use strict';
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const path = require('path');
const CONV = path.resolve(__dirname, '../../models/CompassConversation.js');

function loadModel() {
  // Mongoose registers models globally; delete from both caches so re-require
  // picks up schema changes without "Cannot overwrite model" errors.
  if (mongoose.modelNames().includes('CompassConversation')) {
    mongoose.deleteModel('CompassConversation');
  }
  delete require.cache[CONV];
  return require(CONV);
}

test('CompassConversation message accepts a cards array (additive, optional)', () => {
  const CompassConversation = loadModel();
  const doc = new CompassConversation({
    userId: new mongoose.Types.ObjectId(),
    messages: [{ role: 'assistant', content: 'hi', mode: 'conversation', cards: [{ type: 'readiness_explanation', payload: { value: 70 } }] }],
  });
  const err = doc.validateSync();
  assert.equal(err, undefined, err && err.message);
  assert.equal(doc.messages[0].cards[0].type, 'readiness_explanation');
  assert.equal(doc.messages[0].cards[0].payload.value, 70);
});

test('CompassConversation message is valid with no cards (back-compat)', () => {
  const CompassConversation = loadModel();
  const doc = new CompassConversation({ userId: new mongoose.Types.ObjectId(), messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(doc.validateSync(), undefined);
});
