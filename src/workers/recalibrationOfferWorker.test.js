'use strict';

const assert = require('assert');
const mongoose = require('mongoose');

// ---------------------------------------------------------------------------
// Stub helpers — set before loading the worker
// ---------------------------------------------------------------------------

// `agentFlag` drives the real config/agentFlags env var (pattern from
// src/config/agentFlags.test.js) — default 'false' so pre-existing tests that
// call worker.run() with no deps never touch the real agentDecisionService/DB.
// `deps.record` is a fake the agentic-layer tests inject explicitly when they
// turn the flag on.
function buildStubs({ oldAttempts = [], recentRecals = [], notifyError = false, agentFlag = 'false', recordError = false } = {}) {
  const daPath = require.resolve('../models/DiagnosticAttempt');
  require.cache[daPath] = {
    id: daPath, filename: daPath, loaded: true,
    exports: {
      aggregate: async () => oldAttempts,
      find: () => ({
        distinct: async () => recentRecals,
      }),
    },
  };

  let notified = [];
  const notifPath = require.resolve('../services/notificationService');
  require.cache[notifPath] = {
    id: notifPath, filename: notifPath, loaded: true,
    exports: {
      createInApp: async (userId, payload) => {
        if (notifyError) throw new Error('notification failed');
        notified.push({ userId: String(userId), ...payload });
      },
    },
  };

  if (agentFlag === undefined) {
    delete process.env.AGENT_RECALIBRATION_COACH_ENABLED;
  } else {
    process.env.AGENT_RECALIBRATION_COACH_ENABLED = agentFlag;
  }

  const records = [];
  const record = async (payload) => {
    if (recordError) throw new Error('record failed');
    records.push(payload);
  };

  // Force fresh worker load
  const workerPath = require.resolve('./recalibrationOfferWorker');
  delete require.cache[workerPath];
  const worker = require('./recalibrationOfferWorker');

  return { worker, getNotified: () => notified, getRecords: () => records, deps: { record } };
}

function teardown() {
  [
    '../models/DiagnosticAttempt',
    '../services/notificationService',
    './recalibrationOfferWorker',
  ].forEach(p => { delete require.cache[require.resolve(p)]; });
  delete process.env.AGENT_RECALIBRATION_COACH_ENABLED;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function test_sendsOfferToEligibleUsers() {
  const userId1 = new mongoose.Types.ObjectId();
  const userId2 = new mongoose.Types.ObjectId();
  const thirtyFiveDaysAgo = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);

  const { worker, getNotified } = buildStubs({
    oldAttempts: [
      { _id: userId1, latestCompletedAt: thirtyFiveDaysAgo, latestAttemptType: 'initial' },
      { _id: userId2, latestCompletedAt: thirtyFiveDaysAgo, latestAttemptType: 'initial' },
    ],
    recentRecals: [], // no recent recalibrations
  });

  try {
    const result = await worker.run();

    assert.strictEqual(result.notified, 2, 'should notify both eligible users');
    const notified = getNotified();
    assert.strictEqual(notified.length, 2);
    assert.ok(notified.every(n => n.type === 'recalibration_offer'));
  } finally {
    teardown();
  }
}

async function test_skipsUsersWithRecentRecalibration() {
  const userId1 = new mongoose.Types.ObjectId();
  const userId2 = new mongoose.Types.ObjectId();
  const thirtyFiveDaysAgo = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);

  const { worker, getNotified } = buildStubs({
    oldAttempts: [
      { _id: userId1, latestCompletedAt: thirtyFiveDaysAgo, latestAttemptType: 'initial' },
      { _id: userId2, latestCompletedAt: thirtyFiveDaysAgo, latestAttemptType: 'initial' },
    ],
    // userId2 already has a recent recalibration
    recentRecals: [userId2],
  });

  try {
    const result = await worker.run();

    assert.strictEqual(result.notified, 1, 'should only notify user without recent recal');
    const notified = getNotified();
    assert.strictEqual(notified.length, 1);
    assert.strictEqual(String(notified[0].userId), String(userId1));
  } finally {
    teardown();
  }
}

async function test_recordsLedgerNudgeWhenFlagOn() {
  const userId1 = new mongoose.Types.ObjectId();
  const completedAt = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);

  const { worker, getRecords, deps } = buildStubs({
    oldAttempts: [
      { _id: userId1, latestCompletedAt: completedAt, latestAttemptType: 'initial' },
    ],
    recentRecals: [],
    agentFlag: 'true',
  });

  try {
    const result = await worker.run(deps);

    assert.strictEqual(result.notified, 1);
    const records = getRecords();
    assert.strictEqual(records.length, 1, 'exactly one record call per notified user');
    assert.deepStrictEqual(records[0], {
      agentId: 'recalibration_coach',
      decisionType: 'nudge',
      userId: userId1,
      contextSnapshot: { latestCompletedAt: completedAt, latestAttemptType: 'initial' },
      action: { kind: 'recalibration_offer' },
      promptVersion: 'recal-coach-v1',
    });
  } finally {
    teardown();
  }
}

async function test_noLedgerRecordWhenFlagOff() {
  const userId1 = new mongoose.Types.ObjectId();
  const userId2 = new mongoose.Types.ObjectId();
  const thirtyFiveDaysAgo = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);

  const { worker, getRecords, deps } = buildStubs({
    oldAttempts: [
      { _id: userId1, latestCompletedAt: thirtyFiveDaysAgo, latestAttemptType: 'initial' },
      { _id: userId2, latestCompletedAt: thirtyFiveDaysAgo, latestAttemptType: 'initial' },
    ],
    recentRecals: [],
    agentFlag: 'false',
  });

  try {
    const result = await worker.run(deps);

    assert.strictEqual(result.notified, 2, 'notified count unchanged by flag');
    assert.strictEqual(getRecords().length, 0, 'no ledger record calls when flag is off');
  } finally {
    teardown();
  }
}

async function test_ledgerFailureDoesNotBlockNotification() {
  const userId1 = new mongoose.Types.ObjectId();
  const thirtyFiveDaysAgo = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);

  const { worker, getNotified, getRecords, deps } = buildStubs({
    oldAttempts: [
      { _id: userId1, latestCompletedAt: thirtyFiveDaysAgo, latestAttemptType: 'initial' },
    ],
    recentRecals: [],
    agentFlag: 'true',
    recordError: true,
  });

  try {
    const result = await worker.run(deps);

    assert.strictEqual(result.notified, 1, 'notification still sent despite ledger failure');
    assert.strictEqual(getNotified().length, 1);
    assert.strictEqual(getRecords().length, 0, 'failed record call is never pushed');
  } finally {
    teardown();
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

(async () => {
  const tests = [
    test_sendsOfferToEligibleUsers,
    test_skipsUsersWithRecentRecalibration,
    test_recordsLedgerNudgeWhenFlagOn,
    test_noLedgerRecordWhenFlagOff,
    test_ledgerFailureDoesNotBlockNotification,
  ];

  let failed = 0;
  for (const t of tests) {
    try {
      await t();
      console.log(`  PASS  ${t.name}`);
    } catch (err) {
      console.error(`  FAIL  ${t.name}: ${err.message}`);
      failed++;
    }
  }

  if (failed > 0) process.exitCode = 1;
})();
