'use strict';

const assert = require('assert');
const mongoose = require('mongoose');

// ---------------------------------------------------------------------------
// Stub helpers — set before loading the worker
// ---------------------------------------------------------------------------

function buildStubs({ oldAttempts = [], recentRecals = [], notifyError = false } = {}) {
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

  // Force fresh worker load
  const workerPath = require.resolve('./recalibrationOfferWorker');
  delete require.cache[workerPath];
  const worker = require('./recalibrationOfferWorker');

  return { worker, getNotified: () => notified };
}

function teardown() {
  [
    '../models/DiagnosticAttempt',
    '../services/notificationService',
    './recalibrationOfferWorker',
  ].forEach(p => { delete require.cache[require.resolve(p)]; });
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

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

(async () => {
  const tests = [
    test_sendsOfferToEligibleUsers,
    test_skipsUsersWithRecentRecalibration,
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
