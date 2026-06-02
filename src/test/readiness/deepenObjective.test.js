'use strict';
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Module = require('module');

// Stub the queue module BEFORE anything requires it so no Redis connection
// is opened — otherwise the test hangs waiting for the connection to close.
const queueStub = {
  planGenerationQueue: { add: async () => ({}) },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (/config[\\/]queue/.test(request)) return queueStub;
  return origLoad.apply(this, arguments);
};

test('deepenObjective raises target to the Exceptional band, resets ready, logs history', async () => {
  const UserObjective = require('../../models/UserObjective');
  const objectiveService = require('../../services/objectiveService');
  const id = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const saved = { value: null };
  const fakeDoc = {
    _id: id, userId, objectiveType: 'upskilling', target: 80, targetHistory: [],
    readyState: { isReady: true, momentSeen: true },
    save: async function () { saved.value = this; return this; },
  };
  const origFind = UserObjective.findOne;
  UserObjective.findOne = () => fakeDoc;
  const DA = require('../../models/DiagnosticAttempt');
  const origDA = DA.findOne;
  DA.findOne = () => ({ sort: () => ({ lean: async () => ({ _id: new mongoose.Types.ObjectId() }) }) });
  try {
    const out = await objectiveService.deepenObjective(String(userId), String(id));
    // exceptional band for target 80 = min(98, 80+8) = 88
    assert.equal(out.target, 88);
    assert.equal(saved.value.target, 88);
    assert.equal(saved.value.readyState.isReady, false);
    assert.equal(saved.value.targetHistory.at(-1).reason, 'deepen');
  } finally {
    UserObjective.findOne = origFind;
    DA.findOne = origDA;
    Module._load = origLoad;
  }
});
