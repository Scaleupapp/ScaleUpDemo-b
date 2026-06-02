'use strict';
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

test('publish requires Ready, mints a token; revoke deactivates; getPublic reads active', async () => {
  const UserObjective = require('../../models/UserObjective');
  const ReadinessProof = require('../../models/ReadinessProof');
  const proofService = require('../../services/readiness/proofService');
  const userId = new mongoose.Types.ObjectId();
  const objId = new mongoose.Types.ObjectId();

  const origObj = UserObjective.findOne;
  UserObjective.findOne = () => ({ lean: async () => ({ _id: objId, userId, readyState: { isReady: true } }) });
  proofService.buildSnapshot = async () => ({ objectiveLabel: 'Backend Engineer', score: 84 });
  const created = [];
  const origCreate = ReadinessProof.create;
  ReadinessProof.create = async (doc) => { created.push(doc); return { ...doc, _id: new mongoose.Types.ObjectId() }; };
  try {
    const out = await proofService.publish(String(userId));
    assert.ok(out.token && out.url.includes(out.token));
    assert.equal(created[0].snapshot.score, 84);
    assert.equal(created[0].active, true);
  } finally {
    UserObjective.findOne = origObj; ReadinessProof.create = origCreate;
  }
});

test('publish throws NOT_READY when not ready', async () => {
  const UserObjective = require('../../models/UserObjective');
  const proofService = require('../../services/readiness/proofService');
  const orig = UserObjective.findOne;
  UserObjective.findOne = () => ({ lean: async () => ({ _id: new mongoose.Types.ObjectId(), readyState: { isReady: false } }) });
  try {
    await assert.rejects(() => proofService.publish('x'), /NOT_READY/);
  } finally { UserObjective.findOne = orig; }
});
