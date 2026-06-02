'use strict';
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const UserObjective = require('../../models/UserObjective');

// markMomentSeen is exported from you.js for testability.
const { markMomentSeen } = require('../../routes/v2/you');

test('markMomentSeen sets momentSeen + momentSeenAt on the primary objective', async () => {
  const calls = [];
  const fakeUpdateOne = async (filter, update) => { calls.push({ filter, update }); return { matchedCount: 1 }; };
  const orig = UserObjective.updateOne;
  UserObjective.updateOne = fakeUpdateOne;
  try {
    const userId = new mongoose.Types.ObjectId();
    await markMomentSeen(String(userId));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].update.$set.momentSeen ? true : calls[0].update.$set['readyState.momentSeen'], true);
  } finally {
    UserObjective.updateOne = orig;
  }
});
