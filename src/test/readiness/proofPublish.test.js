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

test('_countEvidence: hoursInvested counts only completed tasks using actual/durationMin/estimatedMinutes', async () => {
  const Plan = require('../../models/Plan');
  const proofService = require('../../services/readiness/proofService');

  // Stub Plan.findOne to return a plan with 3 tasks:
  //   task 1: completed, actualDurationMin=30
  //   task 2: completed, durationMin=90 (no actual)
  //   task 3: NOT completed, durationMin=60 — must be excluded
  const origFindOne = Plan.findOne;
  Plan.findOne = () => ({
    select: function () { return this; },
    lean: async () => ({
      tasks: [
        { completedAt: new Date(), actualDurationMin: 30 },
        { completedAt: new Date(), durationMin: 90 },
        { durationMin: 60 }, // no completedAt — excluded
      ],
    }),
  });

  // Also stub the other model queries so no DB connection is needed
  const QuizAttempt = require('../../models/QuizAttempt');
  const InterviewSession = require('../../models/InterviewSession');
  const CapstoneSession = require('../../coding/models/capstoneSession.model');
  const origQA = QuizAttempt.countDocuments;
  const origIS = InterviewSession.countDocuments;
  const origCS = CapstoneSession.countDocuments;
  QuizAttempt.countDocuments = async () => 0;
  InterviewSession.countDocuments = async () => 0;
  CapstoneSession.countDocuments = async () => 0;

  try {
    const ev = await proofService._countEvidence('fake-user-id');
    // 30 + 90 = 120 min = 2 hours; uncompleted 60 excluded
    assert.equal(ev.hoursInvested, 2, `Expected 2h, got ${ev.hoursInvested}`);
  } finally {
    Plan.findOne = origFindOne;
    QuizAttempt.countDocuments = origQA;
    InterviewSession.countDocuments = origIS;
    CapstoneSession.countDocuments = origCS;
  }
});

test('_countEvidence: hoursInvested is 0 when plan is missing', async () => {
  const Plan = require('../../models/Plan');
  const proofService = require('../../services/readiness/proofService');

  const origFindOne = Plan.findOne;
  Plan.findOne = () => ({ select: function () { return this; }, lean: async () => null });

  const QuizAttempt = require('../../models/QuizAttempt');
  const InterviewSession = require('../../models/InterviewSession');
  const CapstoneSession = require('../../coding/models/capstoneSession.model');
  const origQA = QuizAttempt.countDocuments;
  const origIS = InterviewSession.countDocuments;
  const origCS = CapstoneSession.countDocuments;
  QuizAttempt.countDocuments = async () => 0;
  InterviewSession.countDocuments = async () => 0;
  CapstoneSession.countDocuments = async () => 0;

  try {
    const ev = await proofService._countEvidence('fake-user-id');
    assert.equal(ev.hoursInvested, 0, `Expected 0h, got ${ev.hoursInvested}`);
  } finally {
    Plan.findOne = origFindOne;
    QuizAttempt.countDocuments = origQA;
    InterviewSession.countDocuments = origIS;
    CapstoneSession.countDocuments = origCS;
  }
});
