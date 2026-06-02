'use strict';
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const UserObjective = require('../../models/UserObjective');

test('readyState defaults to not-ready and accepts the milestone fields', () => {
  const o = new UserObjective({ userId: new mongoose.Types.ObjectId(), objectiveType: 'upskilling' });
  assert.equal(o.readyState?.isReady ?? false, false);
  o.readyState = { isReady: true, readyAt: new Date(), readinessAtReady: 84, targetAtReady: 80, momentSeen: false };
  assert.equal(o.readyState.isReady, true);
  assert.equal(o.readyState.readinessAtReady, 84);
  assert.equal(o.readyState.momentSeen, false);
});
