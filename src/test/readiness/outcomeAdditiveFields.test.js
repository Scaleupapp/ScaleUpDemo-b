'use strict';
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const UserObjective = require('../../models/UserObjective');
const ReadinessProof = require('../../models/ReadinessProof');

test('UserObjective.outcomePrompt + ReadinessProof.achieved exist with defaults', () => {
  const o = new UserObjective({ userId: new mongoose.Types.ObjectId(), objectiveType: 'upskilling' });
  o.outcomePrompt = { due: true, lastAskedAt: new Date() };
  assert.equal(o.outcomePrompt.due, true);
  const p = new ReadinessProof({ token: 't', userId: new mongoose.Types.ObjectId(), objectiveId: new mongoose.Types.ObjectId() });
  assert.equal(p.achieved, false);
});
