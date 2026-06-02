'use strict';
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

test('buildSnapshot freezes served readiness + derives band from targetBands', async () => {
  const UserObjective = require('../../models/UserObjective');
  const ReadinessSnapshot = require('../../models/ReadinessSnapshot');
  const User = require('../../models/User');
  const proofService = require('../../services/readiness/proofService');

  const userId = new mongoose.Types.ObjectId();
  const objId = new mongoose.Types.ObjectId();
  const o = { _id: objId, userId, objectiveType: 'interview_preparation', target: 80,
    analysis: { competencies: [{ name: 'System Design', weight: 8 }] }, createdAt: new Date(Date.now() - 14 * 7 * 864e5) };
  const snap = { value: 84, source: 'composite',
    shadow: { value: 84, coverage: 0.75, breakdown: [
      { competency: 'System Design', score: 88, assessed: true, weight: 8 },
      { competency: 'Databases', score: 72, assessed: true, weight: 5 },
    ] } };

  const origs = {};
  origs.uo = UserObjective.findOne; UserObjective.findOne = () => ({ lean: async () => o });
  origs.rs = ReadinessSnapshot.findOne; ReadinessSnapshot.findOne = () => ({ sort: () => ({ lean: async () => snap }) });
  origs.u = User.findById; User.findById = () => ({ select: () => ({ lean: async () => ({ firstName: 'Aditya', lastName: 'S', profilePicture: null }) }) });
  // evidence counts: stub the count helpers proofService uses
  proofService._countEvidence = async () => ({ assessments: 112, capstonesGraded: 8, hoursInvested: 38 });
  try {
    const s = await proofService.buildSnapshot(String(userId));
    assert.equal(s.score, 84);
    assert.equal(s.target, 80);
    assert.equal(s.band, 'Strong'); // 84 >= strong(80), < exceptional(88)
    assert.equal(s.displayName, 'Aditya S');
    assert.equal(s.competencies[0].name, 'System Design');
    assert.equal(s.evidence.coveragePct, 75);
    assert.equal(s.evidence.assessments, 112);
  } finally {
    UserObjective.findOne = origs.uo; ReadinessSnapshot.findOne = origs.rs; User.findById = origs.u;
  }
});
